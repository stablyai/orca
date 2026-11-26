/**
 * The orchestrator's per-distro records, in their own sidecar: older builds rewrite orca-data.json
 * without fields they do not know, and an unreadable file only costs the orchestrator its memory
 * (the move journal stays the source of truth for any move itself).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
import { lazyZodSchema } from '../../../../shared/schema/lazy-zod-schema'
import { writeDurableSecureJsonFile } from '../../../../shared/secure-storage/secure-file'
import { wslMoveJournalKey } from '../../../../shared/wsl-move/wsl-move-cutover'
import type { WslMoveOrchestratorRecord } from '../../../../shared/wsl-move/wsl-move-orchestrator-types'

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

/** Paths whose last read failed: writing their in-memory map would drop records it never saw. */
const unreadableStorePaths = new Set<string>()

/** Every readable record, keyed by the distro's journal key; a bad record is dropped alone. */
export function readWslMoveOrchestratorRecords(
  userDataPath: string
): Map<string, WslMoveOrchestratorRecord> {
  const storePath = wslMoveOrchestratorStorePath(userDataPath)
  const records = new Map<string, WslMoveOrchestratorRecord>()
  let text: string
  try {
    text = readFileSync(storePath, 'utf8')
  } catch (error) {
    // A missing file is genuinely empty; any other failure proves nothing about the records.
    if (errnoCodeOrUnknown(error) === 'ENOENT') {
      unreadableStorePaths.delete(storePath)
    } else {
      unreadableStorePaths.add(storePath)
    }
    return records
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    unreadableStorePaths.add(storePath)
    return records
  }
  const file = fileSchema.safeParse(raw)
  if (!file.success) {
    unreadableStorePaths.add(storePath)
    return records
  }
  for (const value of Object.values(file.data.distros)) {
    const record = recordSchema.safeParse(value)
    if (record.success) {
      records.set(wslMoveJournalKey(record.data.distro), record.data)
    }
  }
  unreadableStorePaths.delete(storePath)
  return records
}

export function writeWslMoveOrchestratorRecords(
  userDataPath: string,
  records: ReadonlyMap<string, WslMoveOrchestratorRecord>
): void {
  // A failed initial read cannot prove the other distros gone; rewriting would delete their records.
  if (unreadableStorePaths.has(wslMoveOrchestratorStorePath(userDataPath))) {
    throw new Error(`Refusing to overwrite unreadable ${FILE_NAME}`)
  }
  writeDurableSecureJsonFile(wslMoveOrchestratorStorePath(userDataPath), {
    version: 1,
    distros: Object.fromEntries(records)
  })
}
