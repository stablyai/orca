import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'

import type { Store } from '../../persistence/loading-store/store'
import { resolveLocalFileRequestPath } from '../../ipc/filesystem/access/local-file-access-resolution'
import { readLocalFileContent } from '../../ipc/filesystem/filesystem-file-content-inspection'
import { restoreNativeChatPastes } from './native-chat-paste-files'

// A store with no projects: nothing but an access kind decides what a read may reach.
const NO_PROJECTS: Store = Object.assign(Object.create(null), {
  getRepos: () => [],
  getProjects: () => [],
  getProjectGroups: () => [],
  getFolderWorkspaces: () => [],
  getSettings: () => ({ nestWorkspaces: false, workspaceDir: '' })
})

/** Whether the composer preview's chat-image access can read `target`. */
async function chatImageReadable(target: string): Promise<boolean> {
  try {
    await readLocalFileContent(
      await resolveLocalFileRequestPath(target, { kind: 'chat-image' }, NO_PROJECTS)
    )
    return true
  } catch {
    return false
  }
}

describe('native-chat paste folder on disk', () => {
  let root: string
  let folder: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'orca-native-chat-pastes-'))
    folder = path.join(root, 'native-chat-pastes')
    mkdirSync(folder)
    installFakeAppEnvironment({ getPath: () => root })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps only files really inside the folder, and never throws on a bad path', async () => {
    const kept = path.join(folder, 'orca-paste-1.png')
    writeFileSync(kept, 'png')
    const outside = path.join(root, 'outside.png')
    writeFileSync(outside, 'png')
    const linkOut = path.join(folder, 'orca-paste-2.png')
    symlinkSync(outside, linkOut)
    mkdirSync(path.join(folder, 'orca-paste-dir.png'))

    const results = await restoreNativeChatPastes([
      kept,
      linkOut,
      path.join(folder, '..', 'outside.png'),
      path.join(folder, 'orca-paste-dir.png'),
      path.join(folder, 'orca-paste-missing.png'),
      'relative/orca-paste-3.png',
      '',
      42
    ])

    expect(results).toEqual([
      { path: kept, kept: true, exists: true },
      { path: linkOut, kept: false, exists: false },
      { path: path.join(folder, '..', 'outside.png'), kept: false, exists: false },
      { path: path.join(folder, 'orca-paste-dir.png'), kept: false, exists: false },
      { path: path.join(folder, 'orca-paste-missing.png'), kept: false, exists: false },
      { path: 'relative/orca-paste-3.png', kept: false, exists: false },
      { path: '', kept: false, exists: false }
    ])
    await expect(restoreNativeChatPastes('not a list')).resolves.toEqual([])
  })

  it('keeps a paste reached through a symlinked alias of the folder, as /var is of /private/var', async () => {
    const kept = path.join(folder, 'orca-paste-1.png')
    writeFileSync(kept, 'png')
    const alias = path.join(tmpdir(), `orca-native-chat-pastes-alias-${process.pid}`)
    rmSync(alias, { force: true })
    symlinkSync(root, alias)
    try {
      installFakeAppEnvironment({ getPath: () => alias })
      const viaAlias = path.join(alias, 'native-chat-pastes', 'orca-paste-1.png')

      await expect(restoreNativeChatPastes([viaAlias, realpathSync(kept)])).resolves.toEqual([
        { path: viaAlias, kept: true, exists: true },
        { path: realpathSync(kept), kept: true, exists: true }
      ])
      // The preview reads by the stored spelling, through chat-image access.
      expect(await chatImageReadable(viaAlias)).toBe(true)
    } finally {
      rmSync(alias, { force: true })
    }
  })

  it('refuses a path that names an outside file as text while its real path is inside', async () => {
    const secret = path.join(root, 'outside', 'id_rsa')
    mkdirSync(path.dirname(secret), { recursive: true })
    writeFileSync(secret, 'PRIVATE KEY')
    const paste = path.join(folder, 'orca-paste-1.png')
    writeFileSync(paste, 'png')
    // `s/..` resolves through a link for real, but by text it climbs to the secret.
    const workspace = path.join(root, 'ws')
    const depth = workspace.split(path.sep).filter(Boolean).length + 1
    const deep = path.join(workspace, ...Array.from({ length: depth }, (_, i) => `d${i}`))
    mkdirSync(deep, { recursive: true })
    symlinkSync(deep, path.join(workspace, 's'))
    const tail = secret.slice(1)
    mkdirSync(path.dirname(path.join(workspace, tail)), { recursive: true })
    symlinkSync(paste, path.join(workspace, tail))
    const crafted = `${workspace}/s/${'../'.repeat(depth)}${tail}`
    expect(path.resolve(crafted)).toBe(secret)

    await expect(restoreNativeChatPastes([crafted])).resolves.toEqual([
      { path: crafted, kept: false, exists: false }
    ])
    // An outside file never becomes readable: nothing is granted, and chat-image reads only images.
    expect(await chatImageReadable(secret)).toBe(false)
    expect(await chatImageReadable(crafted)).toBe(false)
  })

  it('keeps a paste by its real path, and never makes the file its stored spelling names readable', async () => {
    const secret = path.join(root, 'outside', 'id_rsa')
    mkdirSync(path.dirname(secret), { recursive: true })
    writeFileSync(secret, 'PRIVATE KEY')
    // `folder/link/../y` reaches a real paste through `link`, while `folder/y` by text is a link out.
    const sub = path.join(folder, 'sub')
    mkdirSync(sub)
    mkdirSync(path.join(sub, 'deeper'))
    writeFileSync(path.join(sub, 'orca-paste-y.png'), 'png')
    symlinkSync(path.join(sub, 'deeper'), path.join(folder, 'link'))
    symlinkSync(secret, path.join(folder, 'orca-paste-y.png'))
    const restored = `${folder}/link/../orca-paste-y.png`
    expect(realpathSync.native(restored)).toBe(realpathSync(path.join(sub, 'orca-paste-y.png')))

    await expect(restoreNativeChatPastes([restored])).resolves.toEqual([
      { path: restored, kept: true, exists: true }
    ])
    expect(await chatImageReadable(secret)).toBe(false)
    expect(await chatImageReadable(realpathSync(secret))).toBe(false)
    expect(await chatImageReadable(path.join(folder, 'orca-paste-y.png'))).toBe(false)
  })

  it('does not restore from a paste folder that is itself a link', async () => {
    const outside = path.join(root, 'Documents')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'orca-paste-1.png'), 'x')
    rmSync(folder, { recursive: true })
    symlinkSync(outside, folder)

    await expect(restoreNativeChatPastes([path.join(folder, 'orca-paste-1.png')])).resolves.toEqual(
      [{ path: path.join(folder, 'orca-paste-1.png'), kept: false, exists: false }]
    )
  })
})
