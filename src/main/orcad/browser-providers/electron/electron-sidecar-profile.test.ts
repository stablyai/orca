import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  launchOnElectronSidecarProfile,
  prepareElectronSidecarProfile,
  type ElectronSidecarProfile
} from './electron-sidecar-profile'

let orcadUserData: string

beforeEach(async () => {
  // Short root: a long one would fall back to a temporary profile for the socket's sake.
  orcadUserData = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'orcad-ud-'))
})

afterEach(async () => {
  await rm(orcadUserData, { recursive: true, force: true })
})

describe('prepareElectronSidecarProfile', () => {
  it('gives every start the same private profile, so engine logins survive a restart', async () => {
    const first = await prepareElectronSidecarProfile(orcadUserData)
    expect(first).toEqual({
      path: join(orcadUserData, 'browser-sidecar-profile'),
      persistent: true
    })
    await writeFile(join(first.path, 'Cookies'), 'signed-in')

    const second = await prepareElectronSidecarProfile(orcadUserData)
    expect(second.path).toBe(first.path)
    expect((await stat(join(second.path, 'Cookies'))).isFile()).toBe(true)
    if (process.platform !== 'win32') {
      expect((await stat(second.path)).mode & 0o777).toBe(0o700)
    }
  })

  it('falls back to a temporary profile once when the app exits on the saved one', async () => {
    const launched: ElectronSidecarProfile[] = []
    await launchOnElectronSidecarProfile(
      orcadUserData,
      async (profile) => {
        launched.push(profile)
        if (profile.persistent) {
          throw new Error('newer-schema')
        }
      },
      async () => true
    )
    expect(launched.map((profile) => profile.persistent)).toEqual([true, false])
    expect(launched[1]?.path).not.toBe(launched[0]?.path)
    await rm(launched[1]!.path, { recursive: true, force: true })
  })
})
