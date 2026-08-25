import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import { BrowserClientFileChannelTransport } from './browser-client-file-channel-transport'
import { BrowserClientPageCommandExecutor } from './browser-client-page-command-executor'
import {
  BROWSER_CLIENT_UPLOAD_STAGING_MAX_COMMANDS_PER_PAGE,
  BrowserClientUploadStaging
} from './browser-client-upload-staging'
import type { BrowserRoutePageGuestIdentity } from './browser-route-page-authority'

const partition = `persist:orca-browser-v1-${'a'.repeat(64)}`
let stagingRoot = ''

beforeEach(async () => {
  stagingRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-upload-routing-')))
})

afterEach(async () => {
  await rm(stagingRoot, { recursive: true, force: true })
})

function command(
  overrides: Partial<BrowserClientHostCommandEvent> & { commandSequence: number; commandId: string }
): BrowserClientHostCommandEvent {
  return {
    type: 'command',
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a',
    browserHostClientId: 'client-a',
    browserHostGeneration: 3,
    pageCommandProtocolVersion: 1,
    browserPageId: 'page-a',
    pageHostGeneration: 7,
    ...overrides
  } as BrowserClientHostCommandEvent
}

const createPage = command({
  commandSequence: 1,
  commandId: 'create-a',
  command: { type: 'createPage', browserProfileId: 'profile-a', executionHostKey: 'execution-a' }
} as never)

function uploadCommand(files: string[], commandSequence = 2): BrowserClientHostCommandEvent {
  return command({
    commandSequence,
    commandId: `upload-${commandSequence}`,
    command: { type: 'automation', method: 'browser.upload', params: { element: '#f', files } }
  } as never)
}

function closePageCommand(): BrowserClientHostCommandEvent {
  return command({
    pageReconciliationProtocolVersion: 1,
    commandSequence: 90,
    commandId: 'close-a',
    command: {
      type: 'closePage',
      targetAuthority: {
        authorityRuntimeId: 'runtime-a',
        authorityEpoch: 'epoch-a',
        browserHostClientId: 'client-a',
        browserHostGeneration: 3,
        pageHostGeneration: 7
      }
    }
  } as never)
}

function createHarness(
  options: {
    fileChannel?: BrowserClientFileChannelTransport
    uploadStaging?: BrowserClientUploadStaging
  } = {}
) {
  const uploadStaging = options.uploadStaging ?? new BrowserClientUploadStaging(stagingRoot)
  const automationCalls: { params: { files?: unknown } }[] = []
  const executeAutomation = vi.fn(async (input: { params: { files?: unknown } }) => {
    automationCalls.push(input)
    return { uploaded: true }
  })
  const retireRendererPage = vi.fn(async () => {})
  const releaseRouteSession = vi.fn(() => {})
  const releaseNetworkRoute = vi.fn(async () => {})
  const executor = new BrowserClientPageCommandExecutor({
    orcaProfileId: 'orca-profile-a',
    authorityConnectionIdentity: 'authority-a',
    retainNetworkRoute: async () => ({
      key: 'execution-a',
      executionHostIdentity: 'execution-record-a',
      proxyEndpoint: { host: '127.0.0.1' as const, port: 43123 },
      release: releaseNetworkRoute
    }),
    selectRenderer: () => ({
      rendererWebContentsId: 11,
      isCurrent: () => true,
      mountPage: async () => ({ webContentsId: 41 }),
      retirePage: retireRendererPage
    }),
    routeSessions: { preparePage: async () => ({ partition, release: releaseRouteSession }) },
    routeWebContents: {
      claimGuestLifecycle: (registration: BrowserRoutePageGuestIdentity) => ({
        registration: { ...registration },
        guestAuthority: Symbol('guest'),
        whenDestroyed: Promise.resolve(),
        isCurrent: () => true
      }),
      registerGuest: () => true,
      grantNavigation: () => true,
      revokeNavigation: () => true,
      navigateGuest: async () => true,
      beginGuestRetirement: () => Promise.resolve()
    },
    executeAutomation,
    retireAutomation: async () => {},
    guestBinding: { bind: () => {}, release: () => {} },
    fileChannel: options.fileChannel,
    uploadStaging
  } as never)
  return {
    executor,
    executeAutomation,
    automationCalls,
    uploadStaging,
    retireRendererPage,
    releaseRouteSession,
    releaseNetworkRoute
  }
}

function negotiatedTransport(contents: string): BrowserClientFileChannelTransport {
  const transport = new BrowserClientFileChannelTransport()
  transport.bind({
    fileChannelNegotiated: true,
    fileChannelAvailability: 'negotiated' as const,
    sendFileChannelRequest: async () =>
      ({
        ok: true,
        result: {
          contentBase64: Buffer.from(contents).toString('base64'),
          bytesRead: contents.length,
          totalBytes: contents.length,
          eof: true
        },
        _meta: {}
      }) as never
  })
  return transport
}

describe('client-placed browser.upload routing', () => {
  it('never forwards the remote paths verbatim to the local automation runtime', async () => {
    const transport = negotiatedTransport('remote-bytes')
    const { executor, automationCalls } = createHarness({ fileChannel: transport })
    await executor.handle(createPage, new AbortController().signal)

    const result = await executor.handle(
      uploadCommand(['docs/report.pdf']),
      new AbortController().signal
    )

    expect(result).toEqual({ status: 'completed', value: { uploaded: true } })
    const forwarded = automationCalls[0].params.files as string[]
    expect(forwarded).not.toContain('docs/report.pdf')
    expect(path.basename(forwarded[0])).toBe('report.pdf')
    expect(forwarded[0].startsWith(stagingRoot)).toBe(true)
  })

  it('fails the command instead of resolving remote paths on this desktop when unnegotiated', async () => {
    const { executor, executeAutomation } = createHarness()
    await executor.handle(createPage, new AbortController().signal)

    const result = await executor.handle(
      uploadCommand(['/Users/someone/.ssh/id_ed25519']),
      new AbortController().signal
    )

    expect(result).toEqual({
      status: 'failed',
      errorCode: 'browser_client_file_channel_unsupported'
    })
    expect(executeAutomation).not.toHaveBeenCalled()
  })

  it('keeps the staged copy readable after the command resolves and drops it when the page closes', async () => {
    const transport = negotiatedTransport('remote-bytes')
    const { executor, automationCalls } = createHarness({ fileChannel: transport })
    await executor.handle(createPage, new AbortController().signal)
    await executor.handle(uploadCommand(['docs/report.pdf']), new AbortController().signal)

    // Why: DOM.setFileInputFiles only records the path — Chromium reads it at submit time, so the
    // bytes must still be on disk once browser.upload has already reported success.
    const staged = (automationCalls[0].params.files as string[])[0]
    expect(await readFile(staged, 'utf8')).toBe('remote-bytes')

    expect(await executor.handle(closePageCommand(), new AbortController().signal)).toEqual({
      status: 'completed'
    })
    expect(await readdir(stagingRoot)).toHaveLength(0)
  })

  it('evicts a page oldest-first once it exceeds the staged-command budget', async () => {
    const transport = negotiatedTransport('remote-bytes')
    const { executor, uploadStaging } = createHarness({ fileChannel: transport })
    await executor.handle(createPage, new AbortController().signal)

    for (let sequence = 2; sequence <= 8; sequence += 1) {
      await executor.handle(
        uploadCommand(['docs/report.pdf'], sequence),
        new AbortController().signal
      )
    }

    expect(uploadStaging.activeStagingCount()).toBe(
      BROWSER_CLIENT_UPLOAD_STAGING_MAX_COMMANDS_PER_PAGE
    )
    expect(await readdir(stagingRoot)).toHaveLength(
      BROWSER_CLIENT_UPLOAD_STAGING_MAX_COMMANDS_PER_PAGE
    )
  })

  it('retires the guest and releases the route when the staged copies cannot be removed', async () => {
    const transport = negotiatedTransport('remote-bytes')
    const { executor, retireRendererPage, releaseRouteSession, releaseNetworkRoute } =
      createHarness({
        fileChannel: transport,
        // Why: Chromium still holding a staged file open is EBUSY on Windows, and the partition is
        // only reclaimed once the guest and its route session are gone.
        uploadStaging: new BrowserClientUploadStaging(stagingRoot, {
          mkdir: async () => {},
          writeFile: async () => {},
          removeDirectorySync: () => {},
          removeDirectory: async () => {
            throw new Error('EBUSY: resource busy or locked')
          }
        })
      })
    await executor.handle(createPage, new AbortController().signal)
    await executor.handle(uploadCommand(['docs/report.pdf']), new AbortController().signal)

    expect(await executor.handle(closePageCommand(), new AbortController().signal)).toEqual({
      status: 'failed',
      errorCode: 'browser_client_page_command_failed'
    })

    expect(retireRendererPage).toHaveBeenCalled()
    expect(releaseRouteSession).toHaveBeenCalled()
    expect(releaseNetworkRoute).toHaveBeenCalled()
  })

  it('removes every staged copy when the executor closes', async () => {
    const transport = negotiatedTransport('remote-bytes')
    const { executor } = createHarness({ fileChannel: transport })
    await executor.handle(createPage, new AbortController().signal)
    await executor.handle(uploadCommand(['docs/report.pdf']), new AbortController().signal)

    await executor.close()

    expect(await readdir(stagingRoot)).toHaveLength(0)
  })

  it('reports staged copies the close could not remove', async () => {
    const transport = negotiatedTransport('remote-bytes')
    const { executor } = createHarness({
      fileChannel: transport,
      uploadStaging: new BrowserClientUploadStaging(stagingRoot, {
        mkdir: async () => {},
        writeFile: async () => {},
        removeDirectorySync: () => {},
        removeDirectory: async () => {
          throw new Error('EBUSY: resource busy or locked')
        }
      })
    })
    await executor.handle(createPage, new AbortController().signal)
    await executor.handle(uploadCommand(['docs/report.pdf']), new AbortController().signal)
    // The busy directory fails the close command, so the copies are still staged at shutdown.
    await executor.handle(closePageCommand(), new AbortController().signal)

    // Why: leaving staged bytes behind silently is how a fenced host keeps another user's files.
    await expect(executor.close()).rejects.toMatchObject({
      message: 'Browser client page executor cleanup failed',
      errors: expect.arrayContaining([
        expect.objectContaining({ message: 'Browser client upload staging release failed' })
      ])
    })
  })
})
