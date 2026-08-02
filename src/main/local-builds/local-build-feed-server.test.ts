import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LocalBuildCandidate } from './local-build-candidate'
import { startLocalBuildFeed } from './local-build-feed-server'

describe('startLocalBuildFeed', () => {
  it('serves only tokenized manifest and validated artifact routes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-local-feed-'))
    const artifactPath = join(directory, 'orca-macos-arm64.zip')
    await writeFile(artifactPath, 'zip')
    const artifactFile = await open(artifactPath, 'r')
    const candidate = {
      version: '1.2.3-local.1',
      manifestContent: 'version: 1.2.3-local.1\n',
      artifacts: new Map([['orca-macos-arm64.zip', { file: artifactFile, size: 3 }]]),
      close: () => artifactFile.close()
    } as LocalBuildCandidate
    const feed = await startLocalBuildFeed(candidate)
    try {
      await expect(
        fetch(`${feed.url}latest-mac.yml`).then((response) => response.text())
      ).resolves.toContain('1.2.3-local.1')
      await expect(
        fetch(`${feed.url}orca-macos-arm64.zip`).then((response) => response.text())
      ).resolves.toBe('zip')
      const baseUrl = new URL(feed.url)
      await expect(
        fetch(`${baseUrl.origin}/latest-mac.yml`).then((response) => response.status)
      ).resolves.toBe(404)
    } finally {
      await feed.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
