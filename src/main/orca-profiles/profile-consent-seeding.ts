import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { getOrcaProfileDataFile, getProfileUserDataPath } from './profile-storage-paths'

export type InheritableOrcaProfileConsent = Partial<
  Pick<GlobalSettings, 'telemetry' | 'agentStatusHooksEnabled'>
> | null

// Why: a brand-new profile has no data file, so every consent-shaped default applies afresh —
// telemetry re-defaults to opted-in, and agent status hooks re-default to ON and reinstall
// user-global entries the parent profile deliberately declined. Both decisions are machine-wide,
// and the person already answered them, so the new profile inherits rather than re-asks.
export function seedNewOrcaProfileInheritedConsent(
  profileId: string,
  consent: InheritableOrcaProfileConsent,
  userDataPath = getProfileUserDataPath()
): void {
  const settings: Partial<GlobalSettings> = {}
  if (consent?.telemetry) {
    settings.telemetry = consent.telemetry
  }
  // Why the explicit boolean test: `false` is the value that must survive, and the old
  // telemetry-only early return dropped it whenever the parent had no telemetry block.
  if (typeof consent?.agentStatusHooksEnabled === 'boolean') {
    settings.agentStatusHooksEnabled = consent.agentStatusHooksEnabled
  }
  if (Object.keys(settings).length === 0) {
    return
  }
  const dataFile = getOrcaProfileDataFile(profileId, userDataPath)
  if (existsSync(dataFile)) {
    return
  }
  mkdirSync(dirname(dataFile), { recursive: true })
  const tmpPath = `${dataFile}.tmp`
  writeFileSync(tmpPath, JSON.stringify({ settings }, null, 2), 'utf-8')
  renameSync(tmpPath, dataFile)
}
