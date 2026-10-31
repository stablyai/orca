import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PluginUpdateHold } from '../../../shared/plugins/catalog/plugin-update-policy'
import { PluginUpdateReviewNotices } from './plugin-update-review-notices'

const KEY = 'octo.demo'
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plugin-review-notices-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function notices(
  held: Record<string, PluginUpdateHold>,
  options: { killListed?: string[]; names?: Record<string, string | null> } = {}
) {
  return new PluginUpdateReviewNotices({
    pluginsDataDir: dir,
    getHeld: () => held,
    findName: (key) => (options.names && key in options.names ? options.names[key] : 'Demo'),
    isKillListed: (key) => options.killListed?.includes(key) ?? false
  })
}

describe('PluginUpdateReviewNotices', () => {
  it('tells each held version once, with the publisher from the plugin key', async () => {
    const held = { [KEY]: { version: '2.0.0', reason: 'access' as const } }
    const store = notices(held)
    await expect(store.take()).resolves.toEqual([
      { pluginKey: KEY, name: 'Demo', publisher: 'octo', version: '2.0.0', reason: 'access' }
    ])
    await expect(store.take()).resolves.toEqual([])
  })

  it('stays quiet for a told version after a restart, and tells a newer one', async () => {
    const held: Record<string, PluginUpdateHold> = { [KEY]: { version: '2.0.0', reason: 'access' } }
    await notices(held).take()
    await expect(notices(held).take()).resolves.toEqual([])
    held[KEY] = { version: '2.1.0', reason: 'access' }
    await expect(notices(held).take()).resolves.toMatchObject([
      { pluginKey: KEY, version: '2.1.0' }
    ])
  })

  it('returns every untold hold together so the renderer can group them', async () => {
    const store = notices({
      'octo.a': { version: '1.0.0', reason: 'access' },
      'octo.b': { version: '1.0.0', reason: 'repository' },
      'octo.c': { version: '1.0.0', reason: 'access' }
    })
    await expect(store.take()).resolves.toHaveLength(3)
  })

  it('never tells a kill-listed plugin, and keeps it untold in case it is lifted', async () => {
    const held = { [KEY]: { version: '2.0.0', reason: 'access' as const } }
    await expect(notices(held, { killListed: [KEY] }).take()).resolves.toEqual([])
    await expect(notices(held).take()).resolves.toHaveLength(1)
  })

  it('skips a plugin no longer installed', async () => {
    const held = { [KEY]: { version: '2.0.0', reason: 'access' as const } }
    await expect(notices(held, { names: { [KEY]: null } }).take()).resolves.toEqual([])
  })

  it('gives concurrent windows the notice only once', async () => {
    const store = notices({ [KEY]: { version: '2.0.0', reason: 'access' } })
    const [first, second] = await Promise.all([store.take(), store.take()])
    expect(first.length + second.length).toBe(1)
  })

  it('recovers from a damaged record by telling again rather than hiding', async () => {
    await writeFile(join(dir, 'plugin-update-review-notified.json'), '{not json')
    const store = notices({ [KEY]: { version: '2.0.0', reason: 'access' } })
    await expect(store.take()).resolves.toHaveLength(1)
    const saved = JSON.parse(
      await readFile(join(dir, 'plugin-update-review-notified.json'), 'utf8')
    )
    expect(saved).toEqual({ [KEY]: '2.0.0' })
  })
})
