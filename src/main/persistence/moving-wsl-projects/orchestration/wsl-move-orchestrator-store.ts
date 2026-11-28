/**
 * The orchestrator's per-distro records, in their own sidecar: older builds rewrite orca-data.json
 * without fields they do not know. A file that cannot be read now is never replaced, as it may
 * hold a distro's decline; the move journal stays the source of truth for any move itself.
 */
import { readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
import { lazyZodSchema } from '../../../../shared/schema/lazy-zod-schema'
import { writeDurableSecureJsonFile } from '../../../../shared/secure-storage/secure-file'
import { wslMoveJournalKey } from '../../../../shared/wsl-move/wsl-move-cutover'
import type {
  WslMoveOrchestratorRecord,
  WslMoveOrchestratorState
} from '../../../../shared/wsl-move/wsl-move-orchestrator-types'
import type { WslMoveOrchestratorLoad } from './wsl-move-orchestrator-ports'

const FILE_NAME = 'wsl-move-orchestrator.json'

const blockerSchema = lazyZodSchema(() =>
  z.object({
    kind: z.enum([
      'agent-working',
      'process-running',
      'agent-not-resumable',
      'unverifiable',
      'automation-running',
      'dispatch-running',
      'scrollback-too-large'
    ]),
    ids: z.array(z.string()),
    actions: z.array(z.enum(['wait', 'end', 'skip-project', 'clear-scrollback']))
  })
)

/** A Record, so a kind added to the union without being listed here fails to compile. */
const KNOWN_STATE_KINDS: Record<WslMoveOrchestratorState['kind'], true> = {
  idle: true,
  pending: true,
  deferred: true,
  moving: true,
  'waiting-for-host': true,
  backoff: true,
  parked: true,
  done: true,
  'distro-gone': true,
  'restore-offered': true
}

/** A newer build's state kind; a malformed record of a known kind is dropped instead. */
function hasNewerStateKind(value: unknown): boolean {
  const state = typeof value === 'object' && value !== null && 'state' in value ? value.state : null
  const kind = typeof state === 'object' && state !== null && 'kind' in state ? state.kind : null
  return typeof kind === 'string' && !Object.hasOwn(KNOWN_STATE_KINDS, kind)
}

const stateSchema = lazyZodSchema(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('idle') }),
    z.object({ kind: z.literal('pending') }),
    z.object({
      kind: z.literal('deferred'),
      blockers: z.array(blockerSchema),
      rechecks: z.number().int().nonnegative().default(0)
    }),
    z.object({ kind: z.literal('moving') }),
    z.object({ kind: z.literal('waiting-for-host'), migrationId: z.string() }),
    z.object({
      kind: z.literal('backoff'),
      nextAttemptAt: z.number(),
      reason: z.string(),
      waits: z.number().int().nonnegative().optional()
    }),
    z.object({
      kind: z.literal('parked'),
      reason: z.enum([
        'export-incomplete',
        'manifest-too-large',
        'host-update-required',
        'attempts-exhausted',
        'not-now',
        'declined',
        'removal-pending',
        'stuck',
        'finish-pending'
      ]),
      until: z.number().optional(),
      cause: z.enum(['released-here', 'removed']).optional()
    }),
    z.object({
      kind: z.literal('done'),
      migrationId: z.string(),
      nextCheckAt: z.number().optional(),
      waits: z.number().int().nonnegative().optional()
    }),
    z.object({ kind: z.literal('distro-gone') }),
    z.object({ kind: z.literal('restore-offered') })
  ])
)

const recordSchema = lazyZodSchema(() =>
  z.object({
    distro: z.string().min(1),
    state: stateSchema,
    attempts: z.number().int().nonnegative(),
    appVersion: z.string(),
    updatedAt: z.number()
  })
)

const fileSchema = lazyZodSchema(() =>
  z.object({
    version: z.literal(1),
    distros: z.record(z.string(), z.unknown())
  })
)

export function wslMoveOrchestratorStorePath(userDataPath: string): string {
  return join(userDataPath, FILE_NAME)
}

export type WslMoveOrchestratorStore = {
  load: () => WslMoveOrchestratorLoad
  save: (records: ReadonlyMap<string, WslMoveOrchestratorRecord>) => void
}

type SidecarRead =
  | { kind: 'missing' }
  | { kind: 'read-failed'; code: string }
  | { kind: 'corrupt' }
  | { kind: 'unsupported'; version: number }
  | { kind: 'readable'; distros: Record<string, unknown> }

/** The sidecar's load and save; a newer build's record is written back as read. */
export function createWslMoveOrchestratorStore(
  userDataPath: string,
  now: () => number = Date.now
): WslMoveOrchestratorStore {
  const path = wslMoveOrchestratorStorePath(userDataPath)
  let kept: Record<string, unknown> = {}
  // A newer build's file stays newer for this process: never re-read it on each wake.
  let unsupported = false
  let lastWarning: string | null = null
  // Loads retry on each wake while unreadable: warn when the reason changes, not on every retry.
  const warnOnce = (message: string, detail?: unknown): void => {
    if (lastWarning !== message) {
      lastWarning = message
      console.warn(`[wsl-move] ${message}`, ...(detail === undefined ? [] : [detail]))
    }
  }
  const load = (): WslMoveOrchestratorLoad => {
    if (unsupported) {
      return { kind: 'unreadable' }
    }
    let read: SidecarRead
    try {
      read = parseSidecar(readFileSync(path, 'utf8'))
    } catch (error) {
      const code = errnoCodeOrUnknown(error)
      read = code === 'ENOENT' ? { kind: 'missing' } : { kind: 'read-failed', code }
    }
    if (read.kind === 'read-failed') {
      warnOnce(`Orchestrator state unreadable (${read.code}); automatic moves wait`)
      return { kind: 'unreadable' }
    }
    if (read.kind === 'unsupported') {
      // Left in place, not set aside: the newer build that wrote it reads it again after an
      // upgrade, and starting empty here would auto-move distros it recorded as declined.
      unsupported = true
      console.warn(`[wsl-move] Orchestrator state is version ${read.version}; automatic moves wait`)
      return { kind: 'unreadable' }
    }
    if (read.kind === 'corrupt') {
      // Unparseable bytes must not hold back persistence forever: set them aside and start empty.
      const aside = `${path}.corrupt-${now()}`
      try {
        renameSync(path, aside)
      } catch (error) {
        warnOnce('Could not set aside unparseable orchestrator state', error)
        return { kind: 'unreadable' }
      }
      console.warn(`[wsl-move] Unparseable orchestrator state set aside as ${aside}`)
      lastWarning = null
      return { kind: 'missing', setAside: true }
    }
    lastWarning = null
    if (read.kind !== 'readable') {
      return { kind: 'missing' }
    }
    const records = new Map<string, WslMoveOrchestratorRecord>()
    kept = {}
    for (const [key, value] of Object.entries(read.distros)) {
      const record = recordSchema.safeParse(value)
      if (record.success) {
        records.set(wslMoveJournalKey(record.data.distro), record.data)
      } else if (hasNewerStateKind(value)) {
        kept[key] = value
      }
    }
    return { kind: 'readable', records, unknownKeys: new Set(Object.keys(kept)) }
  }
  const save = (records: ReadonlyMap<string, WslMoveOrchestratorRecord>): void => {
    // Once this build wrote its own record for a distro, a prune of it must not bring back the old.
    kept = Object.fromEntries(Object.entries(kept).filter(([key]) => !records.has(key)))
    writeDurableSecureJsonFile(path, {
      version: 1,
      distros: { ...kept, ...Object.fromEntries(records) }
    })
  }
  return { load, save }
}

function parseSidecar(text: string): SidecarRead {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { kind: 'corrupt' }
  }
  const version =
    typeof raw === 'object' && raw !== null && 'version' in raw ? raw.version : undefined
  if (typeof version === 'number' && version > 1) {
    return { kind: 'unsupported', version }
  }
  const file = fileSchema.safeParse(raw)
  return file.success ? { kind: 'readable', distros: file.data.distros } : { kind: 'corrupt' }
}
