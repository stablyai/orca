import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsPromises from 'node:fs/promises'
import type * as CredentialFileIo from './credential-file-io'

const chmods = vi.hoisted(() => ({ count: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  const countedChmod: typeof actual.chmod = (...args) => {
    chmods.count += 1
    return actual.chmod(...args)
  }
  return { ...actual, default: { ...actual, chmod: countedChmod }, chmod: countedChmod }
})

const posixIt = process.platform === 'win32' ? it.skip : it

/** A fresh module instance has an empty hardening cache, like another process reading the same store. */
async function readerProcess(): Promise<typeof CredentialFileIo> {
  vi.resetModules()
  return import('./credential-file-io')
}

// Guards #44839 in the async credential path: a no-op chmod bumps ctime, so every other process's cache misses
// and chmods back, forever.
describe('credential file hardening', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function restrictedCredential(): string {
    const dir = mkdtempSync(join(tmpdir(), 'orca-credential-perf-'))
    dirs.push(dir)
    chmodSync(dir, 0o700)
    const file = join(dir, 'token.json')
    writeFileSync(file, '{}', { mode: 0o600 })
    chmodSync(file, 0o600)
    return file
  }

  posixIt('five readers of an already-restricted credential chmod nothing', async () => {
    const file = restrictedCredential()
    chmods.count = 0

    for (let reader = 0; reader < 5; reader++) {
      await (await readerProcess()).hardenCredentialFile(file)
    }

    expect(chmods.count).toBe(0)
  })

  posixIt('a reader still restricts a credential whose mode drifted', async () => {
    const file = restrictedCredential()
    chmodSync(file, 0o644)
    chmods.count = 0

    await (await readerProcess()).hardenCredentialFile(file)

    expect(chmods.count).toBe(1)
    expect(statSync(file).mode & 0o7777).toBe(0o600)
  })
})
