import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as filesystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { inspectSourceDirectory, resolveOwnedOverlaySource } from './overlay-source-ownership'
import { sourceOverlayDirName } from './overlay-dir-names'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof filesystem>()
  return { ...actual, lstat: vi.fn(actual.lstat) }
})

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-overlay-source-')))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

it('distinguishes a missing source from an inaccessible source and a linked ancestor', async () => {
  const source = join(root, 'source')
  mkdirSync(source)
  expect(await inspectSourceDirectory(source)).toBe('present')
  expect(await inspectSourceDirectory(join(root, 'missing', 'config'))).toBe('absent')
  expect(await inspectSourceDirectory('relative-config')).toBe('unverifiable')
  writeFileSync(join(root, 'file'), '')
  expect(await inspectSourceDirectory(join(root, 'file'))).toBe('unverifiable')
  symlinkSync(source, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(await inspectSourceDirectory(join(root, 'link', 'missing'))).toBe('unverifiable')
  const error = Object.assign(new Error('Denied'), { code: 'EACCES' })
  vi.mocked(filesystem.lstat).mockRejectedValueOnce(error)
  expect(await inspectSourceDirectory(source)).toBe('unverifiable')
})

it('requires an absolute source whose hash matches the owned overlay', async () => {
  const source = join(root, 'source')
  const overlay = join(root, sourceOverlayDirName(source))
  const manifest = { topLevelEntries: [], pluginEntries: [], sourceConfigDir: source }
  expect(await resolveOwnedOverlaySource(overlay, manifest)).toBe(source)
  expect(
    await resolveOwnedOverlaySource(overlay, { ...manifest, sourceConfigDir: join(root, 'other') })
  ).toBeUndefined()
  expect(
    await resolveOwnedOverlaySource(overlay, { ...manifest, sourceConfigDir: 'relative' })
  ).toBeUndefined()
  expect(
    await resolveOwnedOverlaySource(join(root, '123'), {
      topLevelEntries: [],
      pluginEntries: [],
      sourceConfigDir: source
    })
  ).toBeUndefined()
})

it.skipIf(process.platform === 'win32')(
  'recognizes an older source-scoped manifest only through its named mirrored link',
  async () => {
    const source = join(root, 'retired-source')
    const overlay = join(root, sourceOverlayDirName(source))
    mkdirSync(overlay)
    symlinkSync(join(source, 'opencode.json'), join(overlay, 'opencode.json'))
    const manifest = { topLevelEntries: ['opencode.json'], pluginEntries: [] }
    expect(await resolveOwnedOverlaySource(overlay, manifest)).toBe(source)
    expect(
      await resolveOwnedOverlaySource(overlay, { ...manifest, topLevelEntries: ['../other'] })
    ).toBeUndefined()
    expect(
      await resolveOwnedOverlaySource(overlay, { ...manifest, topLevelEntries: [] })
    ).toBeUndefined()
    rmSync(join(overlay, 'opencode.json'))
    writeFileSync(join(overlay, 'opencode.json'), '{}')
    expect(await resolveOwnedOverlaySource(overlay, manifest)).toBeUndefined()
  }
)

it.skipIf(process.platform === 'win32')('rejects arbitrary legacy source links', async () => {
  const source = join(root, 'source')
  const overlay = join(root, sourceOverlayDirName(source))
  mkdirSync(overlay)
  symlinkSync(join(root, 'other', 'opencode.json'), join(overlay, 'opencode.json'))
  expect(
    await resolveOwnedOverlaySource(overlay, {
      topLevelEntries: ['opencode.json'],
      pluginEntries: []
    })
  ).toBeUndefined()
})
