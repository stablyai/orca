import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readPluginPanelSvg } from './plugin-panel-svg'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('accepts contained SVG icons and rejects unsafe or malformed files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-panel-svg-'))
  roots.push(root)
  await writeFile(
    join(root, 'icon.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0"/></svg>'
  )
  expect((await readPluginPanelSvg(root, 'icon.svg')).toString()).toContain('viewBox')
  await writeFile(
    join(root, 'icon.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="url(#paint)"/></svg>'
  )
  expect((await readPluginPanelSvg(root, 'icon.svg')).length).toBeGreaterThan(0)
  await expect(readPluginPanelSvg(root, '../outside.svg')).rejects.toThrow()
  await expect(readPluginPanelSvg(root, 'icon.png')).rejects.toThrow()
  for (const value of [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path onclick="x"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><image href="https://example.com"/></svg>',
    '<svg viewBox="0 0 24 24"/>',
    '<svg xmlns="urn:not-svg" viewBox="0 0 24 24"/>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><!-- bad--comment --></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="url(https://example.com/x)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><style>@import "https://example.com/x";</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path style="fill:u\\72l(https://example.com/x)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24"><use xlink:href="https://example.com/x"/></svg>',
    'x'.repeat(32769)
  ]) {
    await writeFile(join(root, 'icon.svg'), value)
    await expect(readPluginPanelSvg(root, 'icon.svg')).rejects.toThrow()
  }
})
