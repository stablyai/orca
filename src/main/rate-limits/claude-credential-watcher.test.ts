import { mkdtemp, writeFile, rename, unlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { watchClaudeCredentials } from './claude-credential-watcher'

describe('Claude credential metadata watch', () => {
  it('survives creation, atomic replacement and recreation, and stops cleanly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-credential-watch-'))
    const path = join(dir, '.credentials.json')
    const changed = vi.fn()
    const close = watchClaudeCredentials(dir, changed)
    try {
      await writeFile(path, 'first synthetic credential')
      await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1), { timeout: 5_000 })
      await writeFile(join(dir, 'replacement'), 'replacement synthetic credential')
      await rename(join(dir, 'replacement'), path)
      await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2), { timeout: 5_000 })
      await unlink(path)
      await writeFile(path, 'recreated synthetic credential')
      await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(3), { timeout: 5_000 })
      close()
      await writeFile(path, 'after close')
      await new Promise((resolve) => setTimeout(resolve, 2_100))
      expect(changed).toHaveBeenCalledTimes(3)
    } finally {
      close()
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
