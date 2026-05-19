import { app } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Why: 24h TTL keeps registry overrides fresh without hammering the network.
// Fresh-cache hits never block on fetch — only stale or missing cache triggers
// a network round-trip, and we retry on 5xx with exponential backoff before
// falling back to whatever cache we have (or null → caller uses baked defaults).
export const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000

const DEFAULT_URL =
  'https://raw.githubusercontent.com/stablyai/orca/main/.preset-registry/claude-accounts.json'

export type PresetRegistry = {
  version: number
  presets: Record<string, { opus?: string; sonnet?: string; haiku?: string }>
}

type CacheEnvelope = { fetchedAt: number; data: PresetRegistry }

function cachePath(): string {
  return join(app.getPath('userData'), 'claude-preset-registry-cache.json')
}

async function readCache(): Promise<CacheEnvelope | null> {
  try {
    return JSON.parse(await readFile(cachePath(), 'utf8')) as CacheEnvelope
  } catch {
    return null
  }
}

async function writeCache(envelope: CacheEnvelope): Promise<void> {
  const path = cachePath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(envelope), 'utf8')
}

export type FetchOptions = { maxRetries?: number; baseBackoffMs?: number }

export async function fetchPresetRegistry(
  opts: FetchOptions = {}
): Promise<PresetRegistry | null> {
  const url = process.env.ORCA_PRESET_REGISTRY_URL || DEFAULT_URL
  const cached = await readCache()

  // Fresh cache → return immediately, never block on network.
  if (cached && Date.now() - cached.fetchedAt < REGISTRY_TTL_MS) return cached.data

  const maxRetries = opts.maxRetries ?? 3
  const baseBackoff = opts.baseBackoffMs ?? 500
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, { method: 'GET' })
      if (res.ok) {
        const data = (await res.json()) as PresetRegistry
        await writeCache({ fetchedAt: Date.now(), data })
        return data
      }
      if (res.status >= 500) {
        await new Promise((r) => setTimeout(r, baseBackoff * 2 ** attempt))
        continue
      }
      break // 4xx → don't retry
    } catch {
      await new Promise((r) => setTimeout(r, baseBackoff * 2 ** attempt))
    }
  }
  // Fall back to stale cache if available; else null (caller uses baked defaults).
  return cached?.data ?? null
}

export async function getCachedRegistry(): Promise<{
  data: PresetRegistry | null
  fetchedAt: number | null
}> {
  const c = await readCache()
  return { data: c?.data ?? null, fetchedAt: c?.fetchedAt ?? null }
}

/**
 * Delete the on-disk registry cache so the next `fetchPresetRegistry()` is
 * forced to round-trip the network.
 *
 * Why: the renderer "Refresh defaults" button (T19) needs to bypass the 24h
 * TTL — wiping the file is the simplest way to invalidate it without adding a
 * second invalidation path inside `fetchPresetRegistry`. Swallow ENOENT so
 * the operation is idempotent.
 */
export async function clearPresetRegistryCache(): Promise<void> {
  try {
    await rm(cachePath())
  } catch {
    // No cache file is the desired post-state — ENOENT is a no-op.
  }
}
