import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { localHostObserver } from './ssh-hostile-host-observer'

describe('local hostile-host observer', () => {
  let root = ''

  afterEach(() => {
    if (root) {
      removeTreeSync(root)
      root = ''
    }
  })

  it('reads an absent forbidden-tool log as no calls', async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-observer-'))
    const log = join(root, 'calls.log')
    const observer = localHostObserver(log)
    expect(await observer.readForbiddenToolLog()).toBe('')
    writeFileSync(log, 'npm\r\n')
    expect(await observer.readForbiddenToolLog()).toBe('npm\r\n')
  })

  it('plants idle runtimes whose marker age GC orders by', async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-observer-'))
    const observer = localHostObserver(join(root, 'calls.log'))
    // Forward slashes, as a Windows host's remote paths are spelled.
    const store = `${root.replaceAll('\\', '/')}/runtimes`
    await observer.plantIdleRuntime(store, 'node-old', 'old')
    await observer.plantIdleRuntime(store, 'node-new', 'new')
    const oldMarker = statSync(join(root, 'runtimes', 'node-old', '.verified'))
    const newMarker = statSync(join(root, 'runtimes', 'node-new', '.verified'))
    expect(oldMarker.mtime.getUTCFullYear()).toBe(2000)
    expect(newMarker.mtimeMs).toBeGreaterThan(oldMarker.mtimeMs)
    expect(await observer.exists(`${store}/node-old`)).toBe(true)
    expect(await observer.isFile(`${store}/node-old`)).toBe(false)
    expect(await observer.isFile(`${store}/node-old/.verified`)).toBe(true)
    expect(await observer.exists(`${store}/node-gone`)).toBe(false)
  })

  it('hashes a file and stamps it so a rewrite shows', async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-observer-'))
    const file = join(root, 'node.exe')
    writeFileSync(file, 'abc')
    const observer = localHostObserver(join(root, 'calls.log'))
    expect(await observer.fileSha256(file)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
    const before = await observer.fileStamp(file)
    expect(await observer.fileStamp(file)).toBe(before)
    await new Promise((resolve) => setTimeout(resolve, 20))
    writeFileSync(file, 'abcd')
    expect(await observer.fileStamp(file)).not.toBe(before)
  })
})
