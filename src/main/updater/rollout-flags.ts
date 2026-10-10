/**
 * Server-side kill switches and percent cohorts for the Node runtime rollout flips.
 *
 * The block rides on the update-campaign payload Orca already polls (`nudge.json`); older builds
 * ignore it. Every flag resolves to its baked-in value when the block is absent, invalid, out of
 * the flag's version range, or was never received, so the payload can only move what it names.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { compareVersions, isValidVersion } from '../updater-fallback'

export const ROLLOUT_FLAG_NAMES = [
  'pinned-relay-default',
  'managed-servers-visible',
  'serve-on-orcad-default',
  'legacy-npm-rung-retired',
  'legacy-relay-dir-sweep',
  'windows-relay-wmi-fallback-retired'
] as const
export type RolloutFlagName = (typeof ROLLOUT_FLAG_NAMES)[number]

/** Each flip's shipped behaviour: none of them is active in this build. */
export const BAKED_ROLLOUT_FLAGS: Readonly<Record<RolloutFlagName, boolean>> = {
  'pinned-relay-default': false,
  'managed-servers-visible': false,
  'serve-on-orcad-default': false,
  'legacy-npm-rung-retired': false,
  'legacy-relay-dir-sweep': false,
  'windows-relay-wmi-fallback-retired': false
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

/** Stable per install and flag in [0, 100); salting by flag keeps the flips' cohorts independent. */
export function rolloutBucket(installId: string, name: RolloutFlagName): number {
  const digest = createHash('sha256').update(`${name}:${installId}`).digest()
  return (digest.readUInt32BE(0) % 10_000) / 100
}

function inVersionRange(version: string, entry: RolloutFlagEntry): boolean {
  return (
    (entry.minVersion === undefined || compareVersions(version, entry.minVersion) >= 0) &&
    (entry.maxVersion === undefined || compareVersions(version, entry.maxVersion) <= 0)
  )
}

export type RolloutFlagContext = {
  config: RolloutConfig | null
  appVersion: string
  installId: string | null
}

export function resolveRolloutFlag(name: RolloutFlagName, context: RolloutFlagContext): boolean {
  const baked = BAKED_ROLLOUT_FLAGS[name]
  const entry = context.config?.[name]
  if (!entry || entry.state === 'default') {
    return baked
  }
  if (!isValidVersion(context.appVersion) || !inVersionRange(context.appVersion, entry)) {
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
  if (!context.installId) {
    return baked
  }
  return rolloutBucket(context.installId, name) < percent
}

let lastRolloutConfig: RolloutConfig | null = null

/**
 * Called with each successfully read campaign payload's block. A failed fetch keeps the last
 * block, so a transient network error can never lift a kill switch mid-session.
 */
export function recordRolloutConfig(config: RolloutConfig | null): void {
  lastRolloutConfig = config
}

export function isRolloutFlagActive(
  name: RolloutFlagName,
  context: Omit<RolloutFlagContext, 'config'>
): boolean {
  return resolveRolloutFlag(name, {
    ...context,
    config: readE2ERolloutConfigOverride() ?? lastRolloutConfig
  })
}

/**
 * E2E launches only: a `flags` block read from `ORCA_E2E_ROLLOUT_FLAGS_FILE` on every check, so a
 * spec can flip a flag between two connects without the campaign fetch or a relaunch.
 */
export function readE2ERolloutConfigOverride(
  env: NodeJS.ProcessEnv = process.env,
  // Why fail closed: a packaged release must never take rollout flags from an env-named path.
  isPackaged: boolean = !hasAppEnvironment() || getAppEnvironment().isPackaged()
): RolloutConfig | null {
  const file = env.ORCA_E2E_ROLLOUT_FLAGS_FILE
  if (isPackaged || !env.ORCA_E2E_USER_DATA_DIR || !file) {
    return null
  }
  try {
    return parseRolloutConfig({
      rollout: { version: 1, flags: JSON.parse(readFileSync(file, 'utf8')) }
    })
  } catch {
    return null
  }
}

export function resetRolloutConfigForTests(): void {
  lastRolloutConfig = null
}
