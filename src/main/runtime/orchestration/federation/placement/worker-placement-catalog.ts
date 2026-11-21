import { z } from 'zod'
import { parseExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from '../../../../../shared/json-stream/node-bounded-json-stringify'

export const CATALOG_MAX_BYTES = 2 * 1024 * 1024
export const CATALOG_MAX_ROWS = 5_000
const text = z.string().max(4096)
const host = text.refine((value) => parseExecutionHostId(value)?.id === value)
const repoSchema = z.object({
  id: text.min(1),
  path: text,
  displayName: text,
  kind: z.enum(['git', 'folder']).optional(),
  connectionId: text.nullish(),
  executionHostId: host.nullish()
})
const setupSchema = z.object({
  id: text.min(1),
  projectId: text.min(1),
  repoId: text,
  hostId: host,
  path: text,
  displayName: text,
  kind: z.enum(['git', 'folder']).optional(),
  setupState: z.enum(['ready', 'not-set-up', 'setting-up', 'error', 'unsupported']),
  connectionId: text.nullish(),
  executionHostId: host.nullish(),
  workerExecutionTarget: z
    .object({ kind: z.enum(['native', 'wsl', 'unknown']) })
    .catch({ kind: 'unknown' })
    .optional()
})
export type PlacementCatalogRepo = z.output<typeof repoSchema>
export type PlacementCatalogSetup = z.output<typeof setupSchema>
export const WorkerPlacementCatalogSchema = z.object({
  repos: z.array(repoSchema),
  setups: z.array(setupSchema)
})
export type WorkerPlacementCatalog = z.output<typeof WorkerPlacementCatalogSchema>
export type CatalogReadFailure = 'no_answer' | 'incomplete' | 'oversized'

export function readPlacementCatalogList(
  value: unknown,
  key: 'repos' | 'setups'
): { ok: true; rows: unknown[] } | { ok: false; reason: CatalogReadFailure } {
  if (!isCatalogListReply(value)) {
    return { ok: false, reason: 'incomplete' }
  }
  const rows = value[key]
  if (!Array.isArray(rows)) {
    return { ok: false, reason: 'incomplete' }
  }
  if (rows.length > CATALOG_MAX_ROWS) {
    return { ok: false, reason: 'oversized' }
  }
  try {
    stringifyJsonWithinByteLimit(value, CATALOG_MAX_BYTES)
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof JsonStringifyByteLimitError ? 'oversized' : 'incomplete'
    }
  }
  return { ok: true, rows }
}

export function reducePlacementCatalog(
  repos: unknown[],
  setups: unknown[]
): WorkerPlacementCatalog | null {
  const repoResult = z.array(repoSchema).safeParse(repos)
  const setupResult = z.array(setupSchema).safeParse(setups)
  return repoResult.success && setupResult.success
    ? { repos: repoResult.data, setups: setupResult.data }
    : null
}

function isCatalogListReply(value: unknown): value is { repos?: unknown; setups?: unknown } {
  return value !== null && typeof value === 'object'
}
