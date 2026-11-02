import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hashPluginTree } from '../plugin-content-hash'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import {
  createPluginFrameIntegrity,
  matchesVerifiedDigest,
  verifyPluginFrameTree
} from './plugin-frame-integrity'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function installed(): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-frame-integrity-'))
  roots.push(rootDir)
  await writeFile(join(rootDir, 'app.js'), 'one')
  const tree = await hashPluginTree(rootDir)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: verification reads only pluginKey, rootDir and contentHash.
  return { pluginKey: 'acme.i', rootDir, contentHash: tree.ok ? tree.hash : '' } as never
}

describe('plugin frame integrity', () => {
  it('returns per-file digests of a matching tree and refuses a changed one', async () => {
    const plugin = await installed()
    const digests = await verifyPluginFrameTree(plugin)
    expect(digests?.get('app.js')).toBe(createHash('sha256').update('one').digest('hex'))
    expect(matchesVerifiedDigest(digests, 'app.js', Buffer.from('one'))).toBe(true)
    expect(matchesVerifiedDigest(digests, 'app.js', Buffer.from('two'))).toBe(false)
    await writeFile(join(plugin.rootDir, 'app.js'), 'two')
    await expect(verifyPluginFrameTree(plugin)).rejects.toThrow('content hash mismatch')
    expect(await verifyPluginFrameTree({ ...plugin, contentHash: null })).toBeNull()
  })

  it('holds the 2 s navigation floor under a reload loop and shares concurrent checks', async () => {
    let clock = 0
    const verifyTree = vi.fn(async () => null)
    const check = createPluginFrameIntegrity(verifyTree, () => clock)
    const plugin = await installed()
    await Promise.all([check(plugin, true), check(plugin, true), check(plugin, false)])
    expect(verifyTree).toHaveBeenCalledTimes(1)
    for (let reload = 0; reload < 50; reload += 1) {
      clock += 30
      await check(plugin, true)
    }
    expect(verifyTree).toHaveBeenCalledTimes(1)
    clock = 2_001
    await check(plugin, true)
    expect(verifyTree).toHaveBeenCalledTimes(2)
  })
})
