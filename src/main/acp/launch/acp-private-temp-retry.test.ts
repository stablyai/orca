import { existsSync } from 'node:fs'
import { open, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acpRunFolder } from './acp-private-temp'

describe('acp private temp retry cleanup', () => {
  it('creates and cleanly removes temporary run folder', async () => {
    const root = join(tmpdir(), `test-acp-temp-${Date.now()}`)
    const { path, remove } = await acpRunFolder(root)

    expect(existsSync(path)).toBe(true)

    // Add a dummy file inside the run directory
    const testFile = join(path, 'temp-child.lock')
    await writeFile(testFile, 'locked content')
    expect(existsSync(testFile)).toBe(true)

    await remove()
    expect(existsSync(path)).toBe(false)
  })

  it('retries and succeeds when file is briefly locked during teardown', async () => {
    const root = join(tmpdir(), `test-acp-temp-lock-${Date.now()}`)
    const { path, remove } = await acpRunFolder(root)

    const lockedFile = join(path, 'active-process.bin')
    const handle = await open(lockedFile, 'w')
    await handle.write(Buffer.from('data'))

    // Release the handle after 150ms (Node's retryDelay is 100ms)
    setTimeout(async () => {
      await handle.close().catch(() => {})
    }, 150)

    await remove()
    expect(existsSync(path)).toBe(false)
  })
})
