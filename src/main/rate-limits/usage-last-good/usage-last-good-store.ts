import { readFile } from 'node:fs/promises'
import * as z from 'zod'
import { writePluginFileAtomically } from '../../plugins/installation/plugin-atomic-file-write'
import type { ProviderRateLimits } from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import { hasUsageWindows, withoutResetWindows } from '../service/service-result-policy'
import { LONG_STALE_THRESHOLD_MS, type InternalRateLimitState } from '../service/service-types'

type ProviderKey = keyof InternalRateLimitState
export type UsageLastGoodSnapshot = Partial<Record<ProviderKey, ProviderRateLimits>>

const PROVIDER_BY_KEY: Record<ProviderKey, ProviderRateLimits['provider']> = {
  claude: 'claude',
  codex: 'codex',
  opencodeGo: 'opencode-go',
  kimi: 'kimi',
  antigravity: 'antigravity',
  minimax: 'minimax',
  grok: 'grok',
  cursor: 'cursor',
  zcode: 'zcode',
  muse: 'muse'
}

export const USAGE_PROVIDER_KEYS: readonly ProviderKey[] = [
  'claude',
  'codex',
  'opencodeGo',
  'kimi',
  'antigravity',
  'minimax',
  'grok',
  'cursor',
  'zcode',
  'muse'
]

const WindowSchema = z.looseObject({
  usedPercent: z.number(),
  windowMinutes: z.number(),
  resetsAt: z.number().nullable(),
  resetDescription: z.string().nullable()
})

const ReadingSchema = z.looseObject({
  provider: z.string(),
  session: WindowSchema.nullable(),
  weekly: WindowSchema.nullable(),
  fableWeekly: WindowSchema.nullable().optional(),
  monthly: WindowSchema.nullable().optional(),
  buckets: z.array(WindowSchema.extend({ name: z.string() })).optional(),
  updatedAt: z.number(),
  error: z.string().nullable(),
  status: z.enum(['ok', 'error'])
})

/** What a reading may still show after a restart: current windows of a reading no older than the
 *  longest stale-display allowance. The usual stale policy then governs failed polls. */
export function restorableLastGood(
  limits: ProviderRateLimits,
  now: number
): ProviderRateLimits | null {
  if (now - limits.updatedAt > LONG_STALE_THRESHOLD_MS) {
    return null
  }
  const current = withoutResetWindows(limits, now)
  return hasUsageWindows(current) ? current : null
}

export function parseUsageLastGood(raw: unknown, now: number): UsageLastGoodSnapshot {
  const snapshot: UsageLastGoodSnapshot = {}
  const saved = z.record(z.string(), z.unknown()).safeParse(raw)
  if (!saved.success) {
    return snapshot
  }
  for (const key of USAGE_PROVIDER_KEYS) {
    const parsed = ReadingSchema.safeParse(saved.data[key])
    if (!parsed.success || parsed.data.provider !== PROVIDER_BY_KEY[key]) {
      continue
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: schema checked every field the restore reads; the rest is the host's own earlier output.
    const restored = restorableLastGood(parsed.data as unknown as ProviderRateLimits, now)
    if (restored) {
      snapshot[key] = restored
    }
  }
  return snapshot
}

/** Persists each active provider's last displayed usage windows so a restart can show them
 *  until a fresh poll replaces them. */
export class UsageLastGoodStore {
  private snapshot: UsageLastGoodSnapshot = {}
  private isLoaded = false
  private saving: Promise<void> | null = null
  private dirty = false
  /** The saved windows still current at load time. */
  readonly loaded: Promise<UsageLastGoodSnapshot>

  constructor(private readonly filePath: string | null) {
    this.loaded = (filePath ? readSnapshot(filePath) : Promise.resolve({})).then((saved) => {
      this.snapshot = saved
      this.isLoaded = true
      return parseUsageLastGood(saved, Date.now())
    })
  }

  record(state: InternalRateLimitState): void {
    // Before the load, the empty startup state must not overwrite what was saved.
    if (!this.isLoaded) {
      return
    }
    let changed = false
    for (const key of USAGE_PROVIDER_KEYS) {
      const limits = state[key]
      const keep =
        limits && (limits.status === 'ok' || limits.status === 'error') && hasUsageWindows(limits)
          ? limits
          : undefined
      if (keep === this.snapshot[key]) {
        continue
      }
      // A reading without windows (unavailable, switched account, expired) clears the seed too.
      if (keep) {
        this.snapshot[key] = keep
      } else {
        delete this.snapshot[key]
      }
      changed = true
    }
    if (changed) {
      void this.save()
    }
  }

  /** Settles once every recorded change is on disk. */
  async whenSaved(): Promise<void> {
    while (this.saving) {
      await this.saving
    }
  }

  private async save(): Promise<void> {
    const filePath = this.filePath
    if (!filePath) {
      return
    }
    if (this.saving) {
      this.dirty = true
      return
    }
    this.saving = (async () => {
      do {
        this.dirty = false
        await writePluginFileAtomically(filePath, JSON.stringify(this.snapshot)).catch(
          (error: unknown) => console.warn('[rate-limits] Failed to save last usage', error)
        )
      } while (this.dirty)
    })()
    await this.saving
    this.saving = null
  }
}

async function readSnapshot(filePath: string): Promise<UsageLastGoodSnapshot> {
  try {
    return parseUsageLastGood(JSON.parse(await readFile(filePath, 'utf8')), Date.now())
  } catch {
    return {}
  }
}
