import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetWindowsSecurityLoadForTests,
  setWindowsSecurityForTests
} from '../../shared/windows-security-addon'
import {
  createFakeWindowsSecurity,
  FAKE_USER_SID,
  type FakeWindowsSecurity
} from '../../shared/windows-security-addon.test-fixture'
import {
  ensureWindowsUserDataAclGrant,
  WINDOWS_ACL_GRANT_MARKER_FILE,
  WINDOWS_ACL_GRANT_SCHEME_VERSION,
  type WindowsAclGrantResult
} from './windows-user-data-acl'

function awaitResult(userDataPath: string): Promise<WindowsAclGrantResult> {
  return new Promise((resolve) => {
    ensureWindowsUserDataAclGrant(userDataPath, { onDone: resolve })
  })
}

function writeMarker(userDataPath: string, identity: string): void {
  writeFileSync(
    join(userDataPath, WINDOWS_ACL_GRANT_MARKER_FILE),
    JSON.stringify({ schemeVersion: WINDOWS_ACL_GRANT_SCHEME_VERSION, identity, grantedAt: 1 })
  )
}

const IDENTITY = `*${FAKE_USER_SID}`

describe('ensureWindowsUserDataAclGrant', () => {
  let userDataPath: string
  let fake: FakeWindowsSecurity
  const granted = (): string[] => fake.callsFor('grantAsync').map((call) => call.path)

  beforeEach(() => {
    userDataPath = mkdtempSync(join(os.tmpdir(), 'orca-acl-test-'))
    fake = createFakeWindowsSecurity()
    setWindowsSecurityForTests(fake)
  })

  afterEach(() => {
    resetWindowsSecurityLoadForTests()
    vi.unstubAllEnvs()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('grants each child directory, then the root, then writes the marker', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'))
    mkdirSync(join(userDataPath, 'codex-runtime-home'))
    writeFileSync(join(userDataPath, 'orca-runtime.json'), '{}')

    expect(await awaitResult(userDataPath)).toEqual({ mode: 'granted' })

    expect(granted().slice(0, -1).sort()).toEqual(
      [join(userDataPath, 'agent-hooks'), join(userDataPath, 'codex-runtime-home')].sort()
    )
    expect(granted().at(-1)).toBe(userDataPath)
    expect(fake.callsFor('grantAsync')[0]).toMatchObject({
      sid: FAKE_USER_SID,
      mask: 0x1f01ff,
      options: { inheritable: true, replace: true }
    })
    const marker = JSON.parse(
      readFileSync(join(userDataPath, WINDOWS_ACL_GRANT_MARKER_FILE), 'utf-8')
    )
    expect(marker.schemeVersion).toBe(WINDOWS_ACL_GRANT_SCHEME_VERSION)
    expect(marker.identity).toBe(IDENTITY)
  })

  it('skips every grant when the marker matches the identity', async () => {
    writeMarker(userDataPath, IDENTITY)

    expect(await awaitResult(userDataPath)).toEqual({ mode: 'marker-hit' })
    expect(granted()).toEqual([])
  })

  // Accept legacy identity spelling without a redundant whole-tree regrant.
  it('accepts a marker written under the pre-native USERNAME identity', async () => {
    vi.stubEnv('USERNAME', 'alice')
    writeMarker(userDataPath, 'alice')

    expect(await awaitResult(userDataPath)).toEqual({ mode: 'marker-hit' })
    expect(granted()).toEqual([])
  })

  it('re-grants when the marker belongs to a different identity', async () => {
    vi.stubEnv('USERNAME', 'alice')
    writeMarker(userDataPath, '*S-1-5-21-9-9-9-1001')

    expect(await awaitResult(userDataPath)).toEqual({ mode: 'granted' })
    expect(granted()).toEqual([userDataPath])
  })

  it('keeps going past a failed child, then withholds the marker so the next launch retries', async () => {
    const locked = join(userDataPath, 'locked')
    mkdirSync(locked)
    mkdirSync(join(userDataPath, 'fine'))
    fake.failing.add(locked)

    const result = await awaitResult(userDataPath)

    expect(result).toMatchObject({ mode: 'failed', reason: expect.stringContaining('locked') })
    expect(granted()).toContain(userDataPath)
    expect(() => readFileSync(join(userDataPath, WINDOWS_ACL_GRANT_MARKER_FILE))).toThrow()
  })

  it('still grants the root when its children cannot be listed, and reports the failure', async () => {
    // Model refused child listing while the root grant remains possible.
    const unlistable = join(userDataPath, 'unlistable')
    writeFileSync(unlistable, '')

    const result = await awaitResult(unlistable)

    expect(result).toMatchObject({ mode: 'failed', reason: expect.stringContaining('ENOTDIR') })
    expect(granted()).toEqual([unlistable])
  })

  it('no-ops when the addon cannot load', async () => {
    setWindowsSecurityForTests(null)

    expect(await awaitResult(userDataPath)).toEqual({ mode: 'no-identity' })
    expect(granted()).toEqual([])
  })

  it('ignores a corrupt marker and re-grants', async () => {
    writeFileSync(join(userDataPath, WINDOWS_ACL_GRANT_MARKER_FILE), '{not json')

    expect(await awaitResult(userDataPath)).toEqual({ mode: 'granted' })
  })
})
