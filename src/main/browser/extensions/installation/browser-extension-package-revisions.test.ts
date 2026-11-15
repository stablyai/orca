import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({
  app: { hasSingleInstanceLock: () => false, once: vi.fn() }
}))
vi.mock('./browser-extension-install-store', () => ({
  getBrowserExtensionInstallStore: () => ({ root: store.root, get: () => null })
}))

const { acquireBrowserExtensionPackageRevision: acquire, forgetBrowserExtensionPackageRevision } =
  await import('./browser-extension-package-revisions')

it('retries run-directory initialization on a later activation after failure and shares the successful directory', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'orca-revision-retry-'))
  store.root = join(temporary, 'store')
  mkdirSync(store.root)
  const cache = join(store.root, 'execution-cache')
  writeFileSync(cache, 'temporarily unavailable')
  const source = join(temporary, 'source')
  mkdirSync(source)
  const manifest = '{"manifest_version":3,"name":"Retry","version":"1.0"}'
  writeFileSync(join(source, 'manifest.json'), manifest)
  writeFileSync(join(source, 'page.js'), 'globalThis.selected = "recovered"')
  const otherSource = join(temporary, 'other-source')
  mkdirSync(otherSource)
  writeFileSync(join(otherSource, 'manifest.json'), manifest)
  writeFileSync(join(otherSource, 'page.js'), 'globalThis.selected = "other"')
  try {
    expect(
      await Promise.allSettled([
        acquire({ id: 'first', path: source }, manifest, new Set()),
        acquire({ id: 'second', path: otherSource }, manifest, new Set())
      ])
    ).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ code: 'EEXIST' }) },
      { status: 'rejected', reason: expect.objectContaining({ code: 'EEXIST' }) }
    ])
    unlinkSync(cache)
    const [first, second] = await Promise.all([
      acquire({ id: 'first', path: source }, manifest, new Set()),
      acquire({ id: 'second', path: otherSource }, manifest, new Set())
    ])
    expect(readFileSync(join(first.directory, 'page.js'), 'utf8')).toBe(
      'globalThis.selected = "recovered"'
    )
    expect(readFileSync(join(second.directory, 'page.js'), 'utf8')).toBe(
      'globalThis.selected = "other"'
    )
    await acquire({ id: 'first', path: source }, manifest, new Set(), true)
    expect(readdirSync(cache).filter((name) => name.startsWith('run-'))).toHaveLength(1)
  } finally {
    forgetBrowserExtensionPackageRevision('first')
    forgetBrowserExtensionPackageRevision('second')
    await rm(temporary, { recursive: true, force: true })
  }
})
