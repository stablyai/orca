import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() }
}))

type CompositionOptions = {
  createExecutor: (
    input: unknown,
    options: {
      retainNetworkRoute: () => Promise<unknown>
      onPageUnavailable: (browserPageId: string, pageHostGeneration: number) => void
    }
  ) => unknown
}

const compositionOptions: CompositionOptions[] = []
const recordedUrlParams: unknown[] = []

vi.mock('./paired-runtime-browser-client-host', () => ({
  PairedRuntimeBrowserClientHost: class {}
}))

vi.mock('./browser-client-file-channel-transport', () => ({
  BrowserClientFileChannelTransport: class {
    bind(): void {}
  }
}))

vi.mock('./browser-client-page-command-executor', () => ({
  BrowserClientPageCommandExecutor: class {
    readonly recordPublishedPageUrl = (params: unknown): void => {
      recordedUrlParams.push(params)
    }

    findPageByWebContentsId(): undefined {
      return undefined
    }
  }
}))

vi.mock('./paired-runtime-browser-client-host-composition', () => ({
  PairedRuntimeBrowserClientHostComposition: class {
    constructor(options: CompositionOptions) {
      compositionOptions.push(options)
    }

    start(): Promise<unknown> {
      return Promise.resolve({ authority: 'lease-a' })
    }

    close(): Promise<boolean> {
      return Promise.resolve(true)
    }

    whenClosed(): Promise<void> {
      return Promise.resolve()
    }
  }
}))

const ENVIRONMENT_ID = 'environment-a'

const metadata = {
  browserHostClientId: 'host-a',
  browserHostGeneration: 3,
  browserPageId: 'page-a',
  pageHostGeneration: 7,
  revision: 2,
  url: 'https://example.internal/where-the-user-went',
  title: 'Where the user went',
  loading: false,
  canGoBack: true,
  canGoForward: false
}

function pairedEnvironment(): KnownRuntimeEnvironment {
  return {
    id: ENVIRONMENT_ID,
    name: 'Environment A',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: 'endpoint-a',
    endpoints: [
      {
        id: 'endpoint-a',
        endpoint: 'ws://127.0.0.1:9999',
        deviceToken: 'token-a',
        publicKeyB64: 'key-a'
      }
    ]
  } as KnownRuntimeEnvironment
}

/** Boots the host registry the way a launched process does, and hands back its executor seam. */
async function startHost() {
  vi.resetModules()
  compositionOptions.length = 0
  recordedUrlParams.length = 0
  const runtime = await import('./paired-runtime-browser-client-host-runtime')
  runtime.configurePairedRuntimeBrowserClientHostsForOrcaProfile({ orcaProfileId: 'profile-a' })
  await runtime.startPairedRuntimeBrowserClientHost({
    environment: pairedEnvironment(),
    authorityRuntimeId: 'runtime-a'
  })
  const options = compositionOptions[0]
  if (!options) {
    throw new Error('client host composition was never constructed')
  }
  const { publishBrowserClientPageMetadata } =
    await import('./browser-client-page-metadata-transport')
  return { options, publishBrowserClientPageMetadata }
}

afterEach(() => {
  vi.resetModules()
})

describe('published-url observation wiring', () => {
  // The chain the restart depends on: a metadata publish from a guest the user navigated has to
  // reach the executor's inventory, or adoption restores the tab at the URL it was opened with.
  it('routes a page-metadata publish into the executor that owns the page', async () => {
    const { options, publishBrowserClientPageMetadata } = await startHost()
    options.createExecutor(
      { orcaProfileId: 'profile-a' },
      { retainNetworkRoute: () => Promise.resolve({}), onPageUnavailable: () => {} }
    )

    await publishBrowserClientPageMetadata(ENVIRONMENT_ID, metadata).catch(() => undefined)

    expect(recordedUrlParams).toEqual([metadata])
  })

  it('publishes harmlessly before any executor exists', async () => {
    const { publishBrowserClientPageMetadata } = await startHost()

    await expect(
      publishBrowserClientPageMetadata(ENVIRONMENT_ID, metadata).catch((error) => error)
    ).resolves.toBeInstanceOf(Error)
    expect(recordedUrlParams).toEqual([])
  })

  it('does not observe publishes aimed at another environment', async () => {
    const { options, publishBrowserClientPageMetadata } = await startHost()
    options.createExecutor(
      { orcaProfileId: 'profile-a' },
      { retainNetworkRoute: () => Promise.resolve({}), onPageUnavailable: () => {} }
    )

    await publishBrowserClientPageMetadata('environment-b', metadata).catch(() => undefined)

    expect(recordedUrlParams).toEqual([])
  })
})
