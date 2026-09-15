import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedHookInstallationMarker } from '../agent-hooks/managed-hook-install-policy'
import {
  establishManagedHookInstallationMarker,
  getEstablishedManagedHookInstallationMarker,
  hasExistingOrcaInstallationState,
  isManagedHookOnboardingPending,
  managedHookInstallationMarkerPath,
  parseManagedHookInstallationMarker,
  recordManagedHookOnboardingPassed,
  resetEstablishedManagedHookInstallationMarkerForTests,
  resolveManagedHookInstallationMarker
} from './managed-hook-installation-marker'

const PRE_CHANGE: ManagedHookInstallationMarker = {
  installCohort: 'pre-change',
  onboardingDecision: 'passed'
}
const FRESH: ManagedHookInstallationMarker = {
  installCohort: 'post-change',
  onboardingDecision: 'pending'
}

let userDataPath: string

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-hook-marker-'))
  resetEstablishedManagedHookInstallationMarkerForTests()
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function writeMarkerRaw(raw: string): void {
  writeFileSync(managedHookInstallationMarkerPath(userDataPath), raw, 'utf-8')
}

function readMarkerRaw(): string {
  return readFileSync(managedHookInstallationMarkerPath(userDataPath), 'utf-8')
}

describe('parseManagedHookInstallationMarker', () => {
  it('reads a complete record', () => {
    expect(parseManagedHookInstallationMarker(JSON.stringify(FRESH))).toEqual(FRESH)
  })

  const malformed: [string, string][] = [
    ['unparseable JSON', '{{{'],
    ['an empty file', ''],
    ['a partial post-change record', '{"installCohort":"post-change"}'],
    ['a record with only a decision', '{"onboardingDecision":"pending"}'],
    ['an unknown cohort', '{"installCohort":"future","onboardingDecision":"pending"}'],
    ['an unknown decision', '{"installCohort":"post-change","onboardingDecision":"maybe"}'],
    ['a null body', 'null'],
    ['an array', '[{"installCohort":"post-change","onboardingDecision":"pending"}]'],
    ['a non-string cohort', '{"installCohort":1,"onboardingDecision":"pending"}']
  ]

  for (const [name, raw] of malformed) {
    it(`reads ${name} as absent, never as pending`, () => {
      expect(parseManagedHookInstallationMarker(raw)).toBeNull()
    })
  }
})

describe('resolveManagedHookInstallationMarker', () => {
  it('returns a recorded marker untouched and writes nothing', () => {
    const writeMarker = vi.fn(() => true)

    const resolved = resolveManagedHookInstallationMarker({
      readMarker: () => FRESH,
      hasExistingInstallationState: () => false,
      writeMarker
    })

    expect(resolved).toEqual(FRESH)
    expect(writeMarker).not.toHaveBeenCalled()
  })

  it('leaves an upgrading installation pre-change and persists nothing', () => {
    const writeMarker = vi.fn(() => true)

    const resolved = resolveManagedHookInstallationMarker({
      readMarker: () => null,
      hasExistingInstallationState: () => true,
      writeMarker
    })

    expect(resolved).toEqual(PRE_CHANGE)
    expect(writeMarker).not.toHaveBeenCalled()
  })

  it('mints a pending marker for an installation with nothing of Orca in it', () => {
    const writeMarker = vi.fn(() => true)

    const resolved = resolveManagedHookInstallationMarker({
      readMarker: () => null,
      hasExistingInstallationState: () => false,
      writeMarker
    })

    expect(resolved).toEqual(FRESH)
    expect(writeMarker).toHaveBeenCalledWith(FRESH)
  })

  it('falls back to pre-change when the establishing write fails', () => {
    const resolved = resolveManagedHookInstallationMarker({
      readMarker: () => null,
      hasExistingInstallationState: () => false,
      writeMarker: () => false
    })

    expect(resolved).toEqual(PRE_CHANGE)
  })
})

describe('hasExistingOrcaInstallationState', () => {
  it('is false for an empty user-data root', () => {
    expect(hasExistingOrcaInstallationState(userDataPath)).toBe(false)
  })

  const artifacts: [string, () => void][] = [
    ['the profile index', () => writeFileSync(join(userDataPath, 'orca-profile-index.json'), '{}')],
    [
      'only the profile index backup',
      () => writeFileSync(join(userDataPath, 'orca-profile-index.json.bak'), '{}')
    ],
    ['the profiles directory', () => mkdirSync(join(userDataPath, 'profiles'))],
    ['a legacy data file', () => writeFileSync(join(userDataPath, 'orca-data.json'), '{}')],
    ['only a legacy backup', () => writeFileSync(join(userDataPath, 'orca-data.json.bak.3'), '{}')]
  ]

  for (const [name, create] of artifacts) {
    it(`is true when ${name} is present`, () => {
      create()

      expect(hasExistingOrcaInstallationState(userDataPath)).toBe(true)
    })
  }
})

describe('establishManagedHookInstallationMarker on disk', () => {
  it('records a fresh install durably and reports it pending', () => {
    const marker = establishManagedHookInstallationMarker(userDataPath)

    expect(marker).toEqual(FRESH)
    expect(JSON.parse(readMarkerRaw())).toEqual(FRESH)
    expect(isManagedHookOnboardingPending()).toBe(true)
  })

  it('leaves an existing installation pre-change with no file written', () => {
    writeFileSync(join(userDataPath, 'orca-profile-index.json'), '{}')

    const marker = establishManagedHookInstallationMarker(userDataPath)

    expect(marker).toEqual(PRE_CHANGE)
    expect(() => readMarkerRaw()).toThrow()
    expect(isManagedHookOnboardingPending()).toBe(false)
  })

  it('treats a corrupt marker on an existing installation as pre-change', () => {
    writeFileSync(join(userDataPath, 'orca-profile-index.json'), '{}')
    writeMarkerRaw('{"installCohort":"post-ch')

    expect(establishManagedHookInstallationMarker(userDataPath)).toEqual(PRE_CHANGE)
  })

  it('treats a malformed partial post-change record as pre-change, not pending', () => {
    writeFileSync(join(userDataPath, 'orca-profile-index.json'), '{}')
    writeMarkerRaw('{"installCohort":"post-change"}')

    expect(establishManagedHookInstallationMarker(userDataPath)).toEqual(PRE_CHANGE)
    expect(isManagedHookOnboardingPending()).toBe(false)
  })

  it('keeps a pending marker across relaunches without rewriting it', () => {
    establishManagedHookInstallationMarker(userDataPath)
    const first = readMarkerRaw()
    resetEstablishedManagedHookInstallationMarkerForTests()

    expect(establishManagedHookInstallationMarker(userDataPath)).toEqual(FRESH)
    expect(readMarkerRaw()).toBe(first)
  })

  it('answers pre-change before any bootstrap has run', () => {
    expect(getEstablishedManagedHookInstallationMarker()).toEqual(PRE_CHANGE)
    expect(isManagedHookOnboardingPending()).toBe(false)
  })
})

describe('recordManagedHookOnboardingPassed', () => {
  it('flips a pending installation to passed, in memory and on disk', () => {
    establishManagedHookInstallationMarker(userDataPath)

    expect(recordManagedHookOnboardingPassed(userDataPath)).toBe(true)
    expect(JSON.parse(readMarkerRaw())).toEqual({
      installCohort: 'post-change',
      onboardingDecision: 'passed'
    })
    expect(isManagedHookOnboardingPending()).toBe(false)
  })

  // Skipped on Windows only because chmod is a no-op there, not because the behaviour differs.
  it.skipIf(process.platform === 'win32')(
    'reports failure and stays pending when the write cannot land',
    () => {
      establishManagedHookInstallationMarker(userDataPath)
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      // Read-only root: the marker is still readable, but no temp file can be created next to it.
      chmodSync(userDataPath, 0o500)
      try {
        expect(recordManagedHookOnboardingPassed(userDataPath)).toBe(false)
        expect(isManagedHookOnboardingPending()).toBe(true)
      } finally {
        chmodSync(userDataPath, 0o700)
      }
    }
  )

  it('is a no-op for a pre-change installation', () => {
    writeFileSync(join(userDataPath, 'orca-profile-index.json'), '{}')
    establishManagedHookInstallationMarker(userDataPath)

    expect(recordManagedHookOnboardingPassed(userDataPath)).toBe(true)
    expect(() => readMarkerRaw()).toThrow()
  })
})
