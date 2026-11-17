import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { adoptLegacyFolder, type CloudRuntime } from './cloud-sync-local-copy'
import { createCloudSyncStore } from './cloud-sync-store'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'cloud-sync-adopt-'))
  dirs.push(root)
  const store = createCloudSyncStore(join(root, 'userData'))
  const legacyFolder = join(root, 'orca', 'cloud', 'repo', 'my-ws')
  const runtime = (workspaceId: string): CloudRuntime => ({
    workspaceId,
    environmentId: `env-${workspaceId}`,
    folder: join(root, 'orca', 'cloud', 'repo', `my-ws-${workspaceId}`),
    legacyFolder,
    projectRoot: null,
    running: true,
    gone: false
  })
  await mkdir(join(legacyFolder, '.context'), { recursive: true })
  await writeFile(join(legacyFolder, '.context', 'plan.md'), 'plan')
  const entry = { rs: 4, rm: 1, ls: 4, lm: 1 }
  return { store, legacyFolder, runtime, entry }
}

describe('moving a copy out of its old shared-name folder', () => {
  it('moves a folder only this workspace used, with its index', async () => {
    const t = await setup()
    const ws = t.runtime('a')
    await t.store.writeIndex('a', {
      version: 1,
      folder: t.legacyFolder,
      lastSyncedAt: 1,
      entries: { '.context/plan.md': t.entry }
    })

    await adoptLegacyFolder(t.store, ws, [ws])

    expect(await readFile(join(ws.folder, '.context', 'plan.md'), 'utf8')).toBe('plan')
    await expect(stat(t.legacyFolder)).rejects.toThrow()
    expect(Object.keys((await t.store.readIndex('a', ws.folder)).entries)).toEqual([
      '.context/plan.md'
    ])
  })

  it('leaves a folder two workspaces mapped to as it is', async () => {
    const t = await setup()
    const a = t.runtime('a')
    const b = t.runtime('b')
    await t.store.writeIndex('a', {
      version: 1,
      folder: t.legacyFolder,
      lastSyncedAt: 1,
      entries: { '.context/plan.md': t.entry }
    })

    await adoptLegacyFolder(t.store, a, [a, b])

    expect(await readFile(join(t.legacyFolder, '.context', 'plan.md'), 'utf8')).toBe('plan')
    await expect(stat(a.folder)).rejects.toThrow()
    // Its own folder starts empty: nothing there to remove on retire or sync-off.
    expect((await t.store.readIndex('a', a.folder)).entries).toEqual({})
  })
})
