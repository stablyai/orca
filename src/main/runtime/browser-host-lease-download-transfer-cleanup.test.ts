import { describe, expect, it, vi } from 'vitest'

import { getBrowserClientDownloadTransferStore } from './browser-client-download-transfer-store'
import { getBrowserHostLeaseRegistry } from './browser-host-lease-registry-instance'

function createRuntime() {
  const removed: string[] = []
  const runtime = {
    getRuntimeId: () => 'runtime-a',
    writeFileExplorerFileBase64Chunk: vi.fn().mockResolvedValue(undefined),
    commitFileExplorerUpload: vi.fn().mockResolvedValue(undefined),
    deleteFileExplorerPath: vi.fn(async (_worktree: string, relativePath: string) => {
      removed.push(relativePath)
    }),
    createFileExplorerDir: vi.fn().mockResolvedValue(undefined),
    statRuntimeFile: vi.fn().mockRejectedValue(new Error('missing'))
  }
  return { runtime, removed }
}

async function stageTransfer(runtime: object, browserPageId: string): Promise<void> {
  await getBrowserClientDownloadTransferStore(runtime as never).accept({
    transferId: `transfer-${browserPageId}`,
    browserPageId,
    pageHostGeneration: 1,
    workspaceId: 'workspace-1',
    filename: 'report.pdf',
    contentBase64: 'AAA=',
    offset: 0,
    final: false,
    platform: 'linux'
  })
}

function attachHost(runtime: { getRuntimeId(): string }) {
  return getBrowserHostLeaseRegistry(runtime).attach({
    browserHostClientId: 'host-a',
    connectionId: 'connection-a',
    pairedDeviceId: 'device-a',
    hostCapabilities: ['webview'],
    pageCommandProtocolVersion: 1,
    fileChannelProtocolVersion: 1
  })
}

describe('runtime-side download transfer cleanup', () => {
  it('releases staged transfers when a client page retires', async () => {
    const { runtime, removed } = createRuntime()
    const leases = getBrowserHostLeaseRegistry(runtime)
    attachHost(runtime)
    const placement = leases.placeClientPage('page-a', 'host-a')
    await stageTransfer(runtime, 'page-a')
    expect(getBrowserClientDownloadTransferStore(runtime).activeTransferCount()).toBe(1)

    expect(leases.completePageRetirement(leases.beginPageRetirement('page-a', placement))).toBe(
      true
    )

    await vi.waitFor(() =>
      expect(getBrowserClientDownloadTransferStore(runtime).activeTransferCount()).toBe(0)
    )
    expect(removed).toEqual(['.orca/browser-downloads/.incoming-transfer-page-a'])
  })

  it('releases staged transfers of every page a fenced lease hosted', async () => {
    const { runtime, removed } = createRuntime()
    const leases = getBrowserHostLeaseRegistry(runtime)
    const handle = attachHost(runtime)
    leases.placeClientPage('page-a', 'host-a')
    leases.placeClientPage('page-b', 'host-a')
    await stageTransfer(runtime, 'page-a')
    await stageTransfer(runtime, 'page-b')
    expect(getBrowserClientDownloadTransferStore(runtime).activeTransferCount()).toBe(2)

    handle.release()

    await vi.waitFor(() =>
      expect(getBrowserClientDownloadTransferStore(runtime).activeTransferCount()).toBe(0)
    )
    expect(removed).toHaveLength(2)
  })
})
