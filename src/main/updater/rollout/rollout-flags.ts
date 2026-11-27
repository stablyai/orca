/**
 * Server-side kill switches and percent cohorts, carried by the update-campaign payload Orca already
 * polls (`nudge.json`). Older builds ignore the block. A flag falls back to its baked value when the
 * block is absent, invalid, or out of the entry's version range, so the payload only moves what it names.
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { getCanonicalUserDataPath } from '../../persistence/loading-store/user-data-path'
import { compareVersions, isPrereleaseVersion, isValidVersion } from '../releases/updater-fallback'

export const ROLLOUT_FLAG_NAMES = ['mac-menu-bar-helper'] as const
export type RolloutFlagName = (typeof ROLLOUT_FLAG_NAMES)[number]

/** Prerelease (hourly/team) builds dogfood each flip before any stable percentage. */
export function bakedRolloutFlag(_name: RolloutFlagName, appVersion: string): boolean {
  return isPrereleaseVersion(appVersion)
}

const versionString = z.string().refine(isValidVersion)

// Why not strict: a newer server may add fields; an entry this build can't read falls back alone.
const rolloutFlagEntrySchema = z
  .object({
    // `off` is the kill switch; `on` admits `percent` of installs; `default` defers to the build.
    state: z.enum(['default', 'off', 'on']),
    percent: z.number().min(0).max(100).optional(),
    minVersion: versionString.optional(),
    maxVersion: versionString.optional()
  })
  .refine(
    (entry) =>
      entry.minVersion === undefined ||
      entry.maxVersion === undefined ||
      compareVersions(entry.minVersion, entry.maxVersion) <= 0
  )

export type RolloutFlagEntry = z.infer<typeof rolloutFlagEntrySchema>
export type RolloutConfig = Partial<Record<RolloutFlagName, RolloutFlagEntry>>

const campaignRolloutSchema = z.object({
  rollout: z.object({
    version: z.literal(1),
    flags: z.record(z.string(), z.unknown())
  })
})

/** Reads the optional `rollout` block of a campaign payload; anything unreadable is null. */
export function parseRolloutConfig(payload: unknown): RolloutConfig | null {
  const campaign = campaignRolloutSchema.safeParse(payload)
  if (!campaign.success) {
    return null
  }
  const config: RolloutConfig = {}
  for (const name of ROLLOUT_FLAG_NAMES) {
    const parsed = rolloutFlagEntrySchema.safeParse(campaign.data.rollout.flags[name])
    if (parsed.success) {
      config[name] = parsed.data
    }
  }
  return config
}

/** Stable per install and flag in [0, 100); salting by flag keeps cohorts independent. */
export function rolloutBucket(installId: string, name: RolloutFlagName): number {
  const digest = createHash('sha256').update(`${name}:${installId}`).digest()
  return (digest.readUInt32BE(0) % 10_000) / 100
}

export type RolloutFlagContext = {
  config: RolloutConfig | null
  appVersion: string
  installId: string | null
}

export function resolveRolloutFlag(name: RolloutFlagName, context: RolloutFlagContext): boolean {
  const baked = bakedRolloutFlag(name, context.appVersion)
  const entry = context.config?.[name]
  if (!entry || entry.state === 'default' || !isValidVersion(context.appVersion)) {
    return baked
  }
  if (
    (entry.minVersion !== undefined && compareVersions(context.appVersion, entry.minVersion) < 0) ||
    (entry.maxVersion !== undefined && compareVersions(context.appVersion, entry.maxVersion) > 0)
  ) {
    return baked
  }
  if (entry.state === 'off') {
    return false
  }
  const percent = entry.percent ?? 100
  if (percent >= 100) {
    return true
  }
  // Why baked without an id: an unbucketable install must not join every cohort at once.
  return context.installId ? rolloutBucket(context.installId, name) < percent : baked
}

const CACHE_FILE = 'rollout-flags.json'
let cachedConfig: RolloutConfig | null = null
let cachedText: string | null = null
let loading: Promise<void> | null = null

/** Launch-time flips read the last received block; a new block applies from the next launch. */
export function loadCachedRolloutConfig(): Promise<void> {
  loading ??= readFile(join(getCanonicalUserDataPath(), CACHE_FILE), 'utf8').then(
    (text) => {
      cachedText = text
      cachedConfig = parseRolloutConfig({ rollout: { version: 1, flags: JSON.parse(text) } })
    },
    () => {}
  )
  return loading.catch(() => {})
}

export function cachedRolloutConfig(): RolloutConfig | null {
  return cachedConfig
}

/** Saves each successfully read block; a failed fetch keeps the last one so a network blip can't lift a kill switch. */
export async function recordRolloutConfig(config: RolloutConfig | null): Promise<void> {
  const text = JSON.stringify(config ?? {})
  await loadCachedRolloutConfig()
  if (text === cachedText) {
    return
  }
  const target = join(getCanonicalUserDataPath(), CACHE_FILE)
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, target)
    cachedText = text
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    console.warn('[rollout] could not save rollout flags', error)
  }
}

export function resetRolloutConfigForTests(): void {
  cachedConfig = null
  cachedText = null
  loading = null
}
