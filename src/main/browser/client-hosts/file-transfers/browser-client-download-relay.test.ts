import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { BrowserClientHostedPageInventory } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import { BrowserClientDownloadRelay } from './browser-client-download-relay'
import {
  resetBrowserClientDownloadRouting,
  type BrowserClientDownloadRoute
} from './browser-client-download-routing'
import { BrowserClientFileChannelTransport } from './browser-client-file-channel-transport'

const page: BrowserClientHostedPageInventory = Object.freeze({
  authorityRuntimeId: 'runtime-1',
  authorityEpoch: 'epoch-1',
  browserHostClientId: 'host-1',
  browserHostGeneration: 2,
  browserPageId: 'page-1',
  pageHostGeneration: 3,
  browserProfileId: 'profile-1',
  executionHostKey: 'host-key',
  state: 'active'
})

function negotiatedTransport(
  handler: (method: string, params: unknown) => unknown
): BrowserClientFileChannelTransport {
  const transport = new BrowserClientFileChannelTransport()
  transport.bind({
    fileChannelNegotiated: true,
    fileChannelAvailability: 'negotiated',
    sendFileChannelRequest: async (method, params) =>
      ({ ok: true, result: handler(method, params), _meta: {} }) as never
  })
  return transport
}

function remoteRoute(outcome: ReturnType<BrowserClientDownloadRelay['route']>) {
  expect(outcome.kind).toBe('remote')
  return (outcome as { kind: 'remote'; route: BrowserClientDownloadRoute }).route
}

function memoryFilesystem(contents: Buffer) {
  const removed: string[] = []
  const created: string[] = []
  const sweptSync: string[] = []
  return {
    removed,
    created,
    sweptSync,
    filesystem: {
      mkdirSync: (directory: string) => {
        created.push(directory)
      },
      removeDirectorySync: (directory: string) => {
        sweptSync.push(directory)
      },
      readChunks: async function* (_filePath: string, chunkBytes: number) {
        for (let offset = 0; offset < contents.byteLength; offset += chunkBytes) {
          yield contents.subarray(offset, offset + chunkBytes)
        }
      },
      size: async () => contents.byteLength,
      removeDirectory: async (directory: string) => {
        removed.push(directory)
      }
    }
  }
}

afterEach(() => {
  resetBrowserClientDownloadRouting()
})

describe('BrowserClientDownloadRelay', () => {
  it('leaves nothing on disk under the real staging root once transfers settle', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-download-relay-')))
    const stagingRoot = path.join(root, 'downloads')
    // Seed crash leftovers before construction to exercise the startup sweep.
    await mkdir(path.join(stagingRoot, 'crashed-transfer'), { recursive: true })
    await writeFile(path.join(stagingRoot, 'crashed-transfer', 'download'), 'stale')
    try {
      const relay = new BrowserClientDownloadRelay({
        stagingRoot,
        hostLabel: 'build-box',
        transport: negotiatedTransport((_method, params) =>
          (params as { final: boolean }).final
            ? { accepted: true, workspaceRelativePath: '.orca/browser-downloads/report.pdf' }
            : { accepted: true }
        ),
        resolvePage: () => page
      })

      const completed = remoteRoute(relay.route({ guestWebContentsId: 7 }))
      await writeFile(completed.stagingPath, 'hello world')
      await completed.complete('report.pdf')
      const aborted = remoteRoute(relay.route({ guestWebContentsId: 7 }))
      await writeFile(aborted.stagingPath, 'partial')
      await aborted.abort()

      expect(await readdir(stagingRoot)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('tells the page host what started a download as it starts, before any byte', async () => {
    const calls: { method: string; params: unknown }[] = []
    const transport = negotiatedTransport((method, params) => {
      calls.push({ method, params })
      return method.endsWith('begin')
        ? { accepted: true, claimed: true }
        : { accepted: true, workspaceRelativePath: 'Google setup in Orca' }
    })
    const relay = new BrowserClientDownloadRelay({
      stagingRoot: '/tmp/staging',
      hostLabel: 'build-box',
      transport,
      resolvePage: () => page,
      filesystem: memoryFilesystem(Buffer.from('{}')).filesystem
    })
    const route = remoteRoute(
      relay.route({
        guestWebContentsId: 7,
        filename: 'client_secret_1.json',
        documentUrl: 'https://console.cloud.google.com/auth/clients?project=p'
      })
    )
    expect(calls.map((call) => call.method)).toEqual(['browser.clientHost.fileChannel.begin'])
    expect(calls[0].params).toMatchObject({
      browserPageId: 'page-1',
      pageHostGeneration: 3,
      transferId: route.transferId,
      filename: 'client_secret_1.json',
      documentUrl: 'https://console.cloud.google.com/auth/clients?project=p'
    })
    await route.complete('client_secret_1.json')
    expect(calls.slice(1).map((call) => call.method)).toEqual([
      'browser.clientHost.fileChannel.write',
      'browser.clientHost.fileChannel.write'
    ])
  })

  it('fails a download its host could not be told about, unless the host predates that', async () => {
    const relayFailingBegin = (error: Error) => {
      const writes: unknown[] = []
      const transport = negotiatedTransport((method, params) => {
        if (method.endsWith('begin')) {
          throw error
        }
        if (!method.endsWith('abort')) {
          writes.push(params)
        }
        return { accepted: true, workspaceRelativePath: 'report.pdf' }
      })
      const relay = new BrowserClientDownloadRelay({
        stagingRoot: '/tmp/staging',
        hostLabel: 'build-box',
        transport,
        resolvePage: () => page,
        filesystem: memoryFilesystem(Buffer.from('abc')).filesystem
      })
      return { writes, route: remoteRoute(relay.route({ guestWebContentsId: 7 })) }
    }
    const timedOut = relayFailingBegin(new Error('request_timeout'))
    await expect(timedOut.route.complete('report.pdf')).rejects.toThrow(
      'browser_client_download_begin_failed'
    )
    expect(timedOut.writes).toEqual([])

    const older = relayFailingBegin(new Error('method_not_found'))
    await older.route.complete('report.pdf')
    expect(older.writes).toHaveLength(2)
  })

  it('stops the commit and never sends the final chunk once the transfer is aborted', async () => {
    const writes: { final: boolean }[] = []
    const aborts: unknown[] = []
    let route: BrowserClientDownloadRoute | null = null
    const transport = negotiatedTransport((method, params) => {
      if (method.endsWith('abort')) {
        aborts.push(params)
        return { released: true }
      }
      if (method.endsWith('begin')) {
        return { accepted: true, claimed: false }
      }
      writes.push(params as { final: boolean })
      void route?.abort()
      return { accepted: true }
    })
    const { filesystem, removed } = memoryFilesystem(Buffer.from('abc'))
    const relay = new BrowserClientDownloadRelay({
      stagingRoot: '/tmp/staging',
      hostLabel: 'build-box',
      transport,
      resolvePage: () => page,
      filesystem
    })

    route = remoteRoute(relay.route({ guestWebContentsId: 7 }))
    await expect(route.complete('report.pdf')).rejects.toThrow('browser_client_download_canceled')

    expect(writes.map((write) => write.final)).toEqual([false])
    expect(aborts).toHaveLength(1)
    expect(removed).toContain(path.dirname(route.stagingPath))
  })
})
