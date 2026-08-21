import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PLUGIN_STORAGE_VALUE_MAX_BYTES } from '../../shared/plugins/plugin-host-api'
import { PluginKvStore } from './plugin-storage-store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PluginKvStore limits', () => {
  it('enforces the value cap in UTF-8 bytes rather than JavaScript code units', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-storage-'))
    roots.push(root)
    const store = new PluginKvStore(root, 'orca-samples.demo', 'storage.json')
    const value = '😀'.repeat(Math.ceil(PLUGIN_STORAGE_VALUE_MAX_BYTES / 4) + 1)

    expect(store.set('large', value)).toMatchObject({
      ok: false,
      error: expect.stringContaining('exceeds')
    })
    expect(store.get('large')).toBeUndefined()
  })
})
