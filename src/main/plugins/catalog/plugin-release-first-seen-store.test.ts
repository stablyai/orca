import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginReleaseFirstSeenStore } from './plugin-release-first-seen-store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('plugin release first-seen store', () => {
  it('keeps the first sighting across restarts and restarts the clock for a new release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-first-seen-'))
    roots.push(root)
    expect(await new PluginReleaseFirstSeenStore(root).firstSeen('a.b', '1.1.0@c', 100)).toBe(100)
    const reopened = new PluginReleaseFirstSeenStore(root)
    expect(await reopened.firstSeen('a.b', '1.1.0@c', 500)).toBe(100)
    expect(await reopened.firstSeen('a.b', '1.2.0@d', 900)).toBe(900)
  })

  it('treats a damaged file as nothing seen yet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-first-seen-'))
    roots.push(root)
    await writeFile(join(root, 'plugin-release-first-seen.json'), '{not json')
    expect(await new PluginReleaseFirstSeenStore(root).firstSeen('a.b', '1.0.0@c', 7)).toBe(7)
  })
})
