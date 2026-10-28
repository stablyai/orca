/**
 * The orchestrator's per-distro records, in their own sidecar: older builds rewrite orca-data.json
 * without fields they do not know, and an unreadable file only costs the orchestrator its memory
 * (the move journal stays the source of truth for any move itself).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeDurableSecureJsonFile } from '../../../shared/secure-file'
import { wslMoveJournalKey } from '../../../shared/wsl-move/wsl-move-cutover'
import type { WslMoveOrchestratorRecord } from '../../../shared/wsl-move/wsl-move-orchestrator-types'

const FILE_NAME = 'wsl-move-orchestrator.json'

const blockerSchema = z.object({
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

const stateSchema = z.discriminatedUnion('kind', [
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
      'stuck'
    ]),
    until: z.number().optional()
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

const recordSchema = z.object({
  distro: z.string().min(1),
  state: stateSchema,
  attempts: z.number().int().nonnegative(),
  appVersion: z.string(),
  updatedAt: z.number()
})

const fileSchema = z.object({
  version: z.literal(1),
  distros: z.record(z.string(), z.unknown())
})

export function wslMoveOrchestratorStorePath(userDataPath: string): string {
  return join(userDataPath, FILE_NAME)
}

/** Every readable record, keyed by the distro's journal key; a bad record is dropped alone. */
export function readWslMoveOrchestratorRecords(
  userDataPath: string
): Map<string, WslMoveOrchestratorRecord> {
  const records = new Map<string, WslMoveOrchestratorRecord>()
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(wslMoveOrchestratorStorePath(userDataPath), 'utf8'))
  } catch {
    return records
  }
  const file = fileSchema.safeParse(raw)
  if (!file.success) {
    return records
  }
  for (const value of Object.values(file.data.distros)) {
    const record = recordSchema.safeParse(value)
    if (record.success) {
      records.set(wslMoveJournalKey(record.data.distro), record.data)
    }
  }
  return records
}

export function writeWslMoveOrchestratorRecords(
  userDataPath: string,
  records: ReadonlyMap<string, WslMoveOrchestratorRecord>
): void {
  writeDurableSecureJsonFile(wslMoveOrchestratorStorePath(userDataPath), {
    version: 1,
    distros: Object.fromEntries(records)
  })
}
