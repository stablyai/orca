import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  protocol: {
    handle: vi.fn()
  }
}))

import {
  handleAvatarPackAssetRequest,
  resetAvatarPacksDirCache,
  resolveAvatarPacksDir
} from './avatar-pack-protocol'

const tempRoots: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

async function writeCatalog(dir: string, payload: Record<string, unknown> = {}): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'catalog_index.json'), JSON.stringify(payload), 'utf8')
}

afterEach(async () => {
  resetAvatarPacksDirCache()
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('avatar-pack-protocol', () => {
  it('resolves directories in priority order and updates immediately when avatarPacksDir changes', async () => {
    const sandbox = await makeTempDir('orca-avatar-packs-priority-')
    const homeDir = join(sandbox, 'home')
    const userDataDir = join(sandbox, 'user-data')

    const userDataAvatarPacks = join(userDataDir, 'avatar-packs')
    const homeAvatarPacks = join(homeDir, '.orca', 'avatar-packs')
    const envAvatarPacks = join(sandbox, 'env-avatar-packs')
    const customOne = join(homeDir, 'custom-one')
    const customTwo = join(sandbox, 'custom-two')

    await writeCatalog(userDataAvatarPacks, { source: 'userDataAvatarPacks' })
    expect(await resolveAvatarPacksDir({ homeDir, userDataDir, env: {} })).toBe(userDataAvatarPacks)

    resetAvatarPacksDirCache()
    await writeCatalog(homeAvatarPacks, { source: 'homeAvatarPacks' })
    expect(await resolveAvatarPacksDir({ homeDir, userDataDir, env: {} })).toBe(homeAvatarPacks)

    await writeCatalog(envAvatarPacks, { source: 'envAvatarPacks' })
    expect(
      await resolveAvatarPacksDir({
        homeDir,
        userDataDir,
        env: { ORCA_AVATAR_PACKS_DIR: envAvatarPacks }
      })
    ).toBe(envAvatarPacks)

    await writeCatalog(customOne, { source: 'customOne' })
    await writeCatalog(customTwo, { source: 'customTwo' })
    let configuredDir = '~/custom-one'
    const getSettings = () => ({ avatarPacksDir: configuredDir })

    expect(
      await resolveAvatarPacksDir({
        homeDir,
        userDataDir,
        env: { ORCA_AVATAR_PACKS_DIR: envAvatarPacks },
        getSettings
      })
    ).toBe(customOne)

    configuredDir = customTwo
    expect(
      await resolveAvatarPacksDir({
        homeDir,
        userDataDir,
        env: { ORCA_AVATAR_PACKS_DIR: envAvatarPacks },
        getSettings
      })
    ).toBe(customTwo)
  })

  it('blocks sibling-prefix and symlink path traversal while serving valid pack assets', async () => {
    const sandbox = await makeTempDir('orca-avatar-packs-security-')
    const rootDir = join(sandbox, 'bar')
    const siblingEvilDir = join(sandbox, 'bar-evil')

    await writeCatalog(rootDir, { chromahair: { characters: { '0': {} } } })
    const animDir = join(rootDir, 'packs', 'chromahair', 'animations_json')
    await fs.mkdir(animDir, { recursive: true })
    await fs.writeFile(join(animDir, '0_idle.json'), '{"version":1}', 'utf8')

    await fs.mkdir(siblingEvilDir, { recursive: true })
    await fs.writeFile(join(siblingEvilDir, 'secret.json'), '{"secret":true}', 'utf8')
    await fs.symlink(join(siblingEvilDir, 'secret.json'), join(rootDir, 'escaped.json'))

    const options = {
      homeDir: join(sandbox, 'home'),
      userDataDir: join(sandbox, 'user-data'),
      env: {},
      getSettings: () => ({ avatarPacksDir: rootDir })
    }

    const okResp = await handleAvatarPackAssetRequest(
      new Request('orca-avatar-pack://asset/packs/chromahair/animations_json/0_idle.json'),
      options
    )
    expect(okResp.status).toBe(200)
    expect(okResp.headers.get('Content-Type')).toBe('application/json')
    expect(await okResp.text()).toBe('{"version":1}')

    for (const maliciousRequest of [
      new Request('orca-avatar-pack://asset/..%2fbar-evil%2fsecret.json'),
      new Request('orca-avatar-pack://asset/packs/..%2f..%2fbar-evil%2fsecret.json'),
      new Request('orca-avatar-pack://asset/%2fetc%2fpasswd'),
      new Request('orca-avatar-pack://asset/escaped.json'),
      { url: 'orca-avatar-pack://asset/../bar-evil/secret.json', method: 'GET' }
    ]) {
      const blocked = await handleAvatarPackAssetRequest(maliciousRequest, options)
      expect(blocked.status, maliciousRequest.url).toBe(403)
    }
  })
})
