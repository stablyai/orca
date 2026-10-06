import { describe, expect, it, vi } from 'vitest'
import { readRemoteAntigravityIndex } from './antigravity-index-reader'
import { limitRemoteScanFilesystemConcurrency } from './remote-session-scan-concurrency'
import type { RemoteSessionFilesystemProvider } from './remote-session-scanner-types'
import { ANTIGRAVITY_INDEX_MAX_BYTES } from './session-scanner-antigravity-metadata'

function provider(): RemoteSessionFilesystemProvider {
  return {
    readDir: async () => [],
    stat: async () => ({ type: 'file', size: 2, mtime: 0 }),
    readFile: async () => ({ content: '{}', isBinary: false })
  }
}

describe('execution-host Antigravity metadata reads', () => {
  it('forwards regular-file admission and byte limits through the concurrency wrapper', async () => {
    const host = provider()
    const read = vi.fn(async function* () {
      yield Buffer.from('{}')
    })
    host.readTranscriptBytes = read
    expect(
      await readRemoteAntigravityIndex(
        limitRemoteScanFilesystemConcurrency(host),
        '/host/projects.json'
      )
    ).toBe('{}')
    expect(read).toHaveBeenCalledWith('/host/projects.json', undefined, {
      regularFileOnly: true,
      maxBytes: ANTIGRAVITY_INDEX_MAX_BYTES
    })
  })

  it('preserves the existing bounded read-file options on legacy providers', async () => {
    const host = provider()
    const read = vi.spyOn(host, 'readFile')
    expect(
      await readRemoteAntigravityIndex(
        limitRemoteScanFilesystemConcurrency(host),
        '/host/projects.json'
      )
    ).toBe('{}')
    expect(read).toHaveBeenCalledWith('/host/projects.json', {
      maxTextBytes: ANTIGRAVITY_INDEX_MAX_BYTES
    })
  })

  it('does not read directories or symlinks from legacy providers', async () => {
    for (const type of ['directory', 'symlink'] as const) {
      const host = provider()
      host.stat = async () => ({ type, size: 0, mtime: 0 })
      const read = vi.spyOn(host, 'readFile')
      expect(await readRemoteAntigravityIndex(host, '/host/projects.json')).toBeNull()
      expect(read).not.toHaveBeenCalled()
    }
  })

  it('stops waiting for a legacy request that cannot cancel on the wire', async () => {
    const host = provider()
    host.readFile = () => new Promise(() => {})
    const controller = new AbortController()
    const read = readRemoteAntigravityIndex(host, '/host/projects.json', controller.signal)
    await Promise.resolve()
    controller.abort()
    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
  })
})
