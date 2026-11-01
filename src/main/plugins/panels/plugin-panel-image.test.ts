import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PLUGIN_PANEL_IMAGE_MAX_BYTES, readPluginPanelImage } from './plugin-panel-image'

const LOGO = readFileSync(
  join(import.meta.dirname, '../../../../examples/plugins/components-gallery/assets/logo.png')
)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function plugin(): Promise<{ root: string; outside: string }> {
  const base = await mkdtemp(join(tmpdir(), 'orca-panel-image-'))
  roots.push(base)
  const root = join(base, 'plugin')
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, 'assets', 'logo.png'), LOGO)
  // An image extension is not enough: the header must be a real, bounded image.
  await writeFile(join(root, 'assets', 'fake.png'), '<svg onload="alert(1)"/>')
  await writeFile(join(root, 'notes.txt'), 'not an image')
  const outside = join(base, 'secret.png')
  await writeFile(outside, 'outside')
  return { root, outside }
}

describe('readPluginPanelImage', () => {
  it('reads an image inside the plugin of a live components-panel session', async () => {
    const { root } = await plugin()
    const read = (sessionToken: string, path: string) =>
      readPluginPanelImage(
        { resolveComponentsPanelRoot: (token) => (token === 'live' ? root : null) },
        { sessionToken, path }
      )
    expect(await read('live', 'assets/logo.png')).toEqual({
      contentType: 'image/png',
      bytes: new Uint8Array(LOGO)
    })
    expect(await read('stale', 'assets/logo.png')).toBeNull()
    expect(await read('live', 'assets/missing.png')).toBeNull()
  })

  it('refuses anything but an image file inside the plugin', async () => {
    const { root } = await plugin()
    await writeFile(
      join(root, 'assets', 'huge.png'),
      Buffer.alloc(PLUGIN_PANEL_IMAGE_MAX_BYTES + 1)
    )
    const read = (path: unknown) =>
      readPluginPanelImage({ resolveComponentsPanelRoot: () => root }, { sessionToken: 't', path })
    for (const path of [
      'notes.txt',
      'assets/fake.png',
      '../secret.png',
      'assets/huge.png',
      'https://example.com/a.png',
      42
    ]) {
      expect({ path, image: await read(path) }).toEqual({ path, image: null })
    }
  })

  // Why skipped on Windows: creating a symlink there needs Developer Mode or admin rights.
  it.skipIf(process.platform === 'win32')('refuses a symlink that leaves the plugin', async () => {
    const { root, outside } = await plugin()
    await symlink(outside, join(root, 'assets', 'link.png'))
    expect(
      await readPluginPanelImage(
        { resolveComponentsPanelRoot: () => root },
        { sessionToken: 't', path: 'assets/link.png' }
      )
    ).toBeNull()
  })
})
