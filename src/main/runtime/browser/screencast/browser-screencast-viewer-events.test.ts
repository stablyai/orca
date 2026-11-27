import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserScreencastResult } from '../../../../shared/browser/runtime/runtime-browser-contracts'

const watchers = vi.hoisted(() => new Map<string, (event: BrowserScreencastResult) => void>())
vi.mock('../../../browser/guest-lifecycle/manager/browser-manager', () => ({
  browserManager: {
    watchDownloads: (pageId: string, listener: (event: BrowserScreencastResult) => void) => {
      watchers.set(pageId, listener)
      return () => watchers.delete(pageId)
    }
  }
}))

const { startScreencastViewerEvents } = await import('./browser-screencast-viewer-events')

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function finishedDownload(claimLabel?: string): Promise<BrowserScreencastResult[]> {
  const dir = await mkdtemp(path.join(tmpdir(), 'viewer-download-'))
  dirs.push(dir)
  const savePath = path.join(dir, 'key.json')
  await writeFile(savePath, '{"installed":{}}')
  const emitted: BrowserScreencastResult[] = []
  const stop = startScreencastViewerEvents(
    { guestWebContentsId: 1, browserPageId: 'page-1' },
    { downloads: 1, downloadCopyStreams: 1 },
    { emit: (event) => emitted.push(event), pairedDeviceId: 'desk-a' }
  )
  watchers.get('page-1')!({
    type: 'downloadFinished',
    download: {
      browserPageId: 'page-1',
      downloadId: 'd-1',
      status: 'completed',
      savePath,
      ...(claimLabel ? { claimLabel } : {}),
      error: null
    }
  })
  await vi.waitFor(() => expect(emitted).toHaveLength(1))
  stop?.()
  return emitted
}

describe('screencast viewer download events', () => {
  it('never offers a paired device a copy of a download a feature in Orca claimed', async () => {
    const [plain] = await finishedDownload()
    expect(plain).toHaveProperty('copyId')
    const [claimed] = await finishedDownload('Google setup in Orca')
    expect(claimed).not.toHaveProperty('copyId')
  })
})
