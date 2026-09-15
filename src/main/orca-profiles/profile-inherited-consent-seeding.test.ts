import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { getOrcaProfileDataFile } from './profile-storage-paths'
import { seedNewOrcaProfileInheritedConsent } from './profile-consent-seeding'

/**
 * Hooks are user-global and telemetry is per-install, so both decisions belong to the person, not
 * to the profile. A new profile that re-defaulted agentStatusHooksEnabled to ON would reinstall
 * the very entries the parent profile declined.
 */
let userDataPath: string
const NEW_PROFILE = 'local-new'

const TELEMETRY: GlobalSettings['telemetry'] = {
  existedBeforeTelemetryRelease: true,
  optedIn: false,
  installId: 'install-1'
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-profile-seed-'))
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

function seededSettings(): Partial<GlobalSettings> | null {
  const dataFile = getOrcaProfileDataFile(NEW_PROFILE, userDataPath)
  if (!existsSync(dataFile)) {
    return null
  }
  return (JSON.parse(readFileSync(dataFile, 'utf-8')) as { settings: Partial<GlobalSettings> })
    .settings
}

describe('seedNewOrcaProfileInheritedConsent', () => {
  it("carries the parent's opt-out into the new profile", () => {
    seedNewOrcaProfileInheritedConsent(
      NEW_PROFILE,
      { telemetry: TELEMETRY, agentStatusHooksEnabled: false },
      userDataPath
    )

    expect(seededSettings()).toEqual({ telemetry: TELEMETRY, agentStatusHooksEnabled: false })
  })

  it('carries an opt-out even when the parent has no telemetry block at all', () => {
    // The old telemetry-only early return dropped the hook decision entirely on this path.
    seedNewOrcaProfileInheritedConsent(
      NEW_PROFILE,
      { agentStatusHooksEnabled: false },
      userDataPath
    )

    expect(seededSettings()).toEqual({ agentStatusHooksEnabled: false })
  })

  it('carries an opt-in too, so the two profiles agree', () => {
    seedNewOrcaProfileInheritedConsent(NEW_PROFILE, { agentStatusHooksEnabled: true }, userDataPath)

    expect(seededSettings()).toEqual({ agentStatusHooksEnabled: true })
  })

  it('seeds telemetry alone when the parent never touched the hook switch', () => {
    seedNewOrcaProfileInheritedConsent(NEW_PROFILE, { telemetry: TELEMETRY }, userDataPath)

    expect(seededSettings()).toEqual({ telemetry: TELEMETRY })
  })

  it('writes nothing when there is no decision to inherit', () => {
    seedNewOrcaProfileInheritedConsent(NEW_PROFILE, {}, userDataPath)

    expect(seededSettings()).toBeNull()
  })

  it('never overwrites a profile that already has data', () => {
    const dataFile = getOrcaProfileDataFile(NEW_PROFILE, userDataPath)
    mkdirSync(join(userDataPath, 'profiles', NEW_PROFILE), { recursive: true })
    writeFileSync(dataFile, JSON.stringify({ settings: { theme: 'dark' } }), 'utf-8')

    seedNewOrcaProfileInheritedConsent(
      NEW_PROFILE,
      { agentStatusHooksEnabled: false },
      userDataPath
    )

    expect(seededSettings()).toEqual({ theme: 'dark' })
  })
})
