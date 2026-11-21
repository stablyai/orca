import { get, type IncomingMessage } from 'node:http'
import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { LocalBuildCandidate } from './local-build-candidate'
import { startLocalBuildFeed } from './local-build-feed-server'

describe('local build feed shutdown', () => {
  it('closes stalled artifact downloads and releases the owned file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-local-feed-shutdown-'))
    let artifact: FileHandle | undefined
    let feed: Awaited<ReturnType<typeof startLocalBuildFeed>> | undefined
    let response: IncomingMessage | undefined
    let closed: Promise<void> | undefined
    try {
      const file = await open(join(directory, 'fixture.zip'), 'w+')
      artifact = file
      const size = 64 * 1024 * 1024
      await file.truncate(size)
      const closeCandidate = vi.fn(() => file.close())
      const candidate: LocalBuildCandidate = {
        version: '1.2.3-local.1',
        manifestContent: 'version: 1.2.3-local.1\n',
        compatibility: {
          formatVersion: 1,
          appId: 'fixture',
          buildId: 'fixture',
          version: '1.2.3-local.1',
          commit: 'fixture',
          stateSchemaVersion: 1,
          readableStateSchemaVersions: [1],
          daemonProtocolVersion: 1,
          attachableDaemonProtocolVersions: [1],
          platform: 'darwin',
          architecture: 'arm64'
        },
        artifacts: new Map([['fixture.zip', { file, size }]]),
        close: closeCandidate
      }
      feed = await startLocalBuildFeed(candidate)
      const url = `${feed.url}fixture.zip`
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        const request = get(url, (incoming) => {
          incoming.on('error', () => {})
          incoming.pause()
          resolve(incoming)
        })
        request.on('error', reject)
      })
      expect(response.complete).toBe(false)
      closed = feed.close()

      await vi.waitFor(() => expect(file.fd).toBe(-1), { timeout: 1000 })
      await closed
      await feed.close()
      expect(closeCandidate).toHaveBeenCalledOnce()
    } finally {
      response?.destroy()
      await closed
      await feed?.close()
      await artifact?.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
