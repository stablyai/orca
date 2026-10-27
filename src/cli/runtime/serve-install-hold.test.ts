import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readServeInstallEvidence } from './serve-install-hold'
import { isShipItRunningForBundle } from '../../shared/shipit-process-listing'

describe('readServeInstallEvidence', () => {
  let root: string
  let bundle: string
  let executable: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-install-hold-'))
    bundle = join(root, 'Orca.app')
    executable = join(bundle, 'Contents', 'MacOS', 'Orca')
    await mkdir(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    await writeFile(executable, '')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const shipIt = (b: string): string =>
    `${b}/Contents/Frameworks/Squirrel.framework/Resources/ShipIt com.stablyai.orca.ShipIt /state.plist`

  it('holds while ShipIt replaces this bundle, and when the check cannot run', async () => {
    await expect(
      readServeInstallEvidence(executable, {
        platform: 'darwin',
        listProcesses: async () => `/sbin/launchd\n${shipIt(bundle)}\n`
      })
    ).resolves.toEqual({ kind: 'hold', reason: 'installer-running' })
    await expect(
      readServeInstallEvidence(executable, { platform: 'darwin', listProcesses: async () => null })
    ).resolves.toEqual({ kind: 'hold', reason: 'installer-unknown' })
  })

  it("ignores another bundle's ShipIt and an executable that merely contains the name", async () => {
    await expect(
      readServeInstallEvidence(executable, {
        platform: 'darwin',
        listProcesses: async () => `${shipIt('/Applications/Other.app')}\n${executable} --serve\n`
      })
    ).resolves.toEqual({ kind: 'clear' })
  })

  it('holds while the executable is missing, and skips the macOS check elsewhere', async () => {
    await expect(readServeInstallEvidence(join(root, 'gone'))).resolves.toEqual({
      kind: 'hold',
      reason: 'bundle-missing'
    })
    await expect(
      readServeInstallEvidence(executable, {
        platform: 'linux',
        listProcesses: async () => {
          throw new Error('must not list processes off macOS')
        }
      })
    ).resolves.toEqual({ kind: 'clear' })
  })

  it('matches only the ShipIt binary path', () => {
    expect(isShipItRunningForBundle(`  ${shipIt('/A.app')}`, '/A.app')).toBe(true)
    expect(
      isShipItRunningForBundle('/A.app/Contents/Frameworks/Squirrel.framework/Squirrel', '/A.app')
    ).toBe(false)
  })
})
