import { afterEach, describe, expect, it } from 'vitest'

import type { BrowserClientHostedPageInventory } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import { BrowserClientDownloadRelay } from './browser-client-download-relay'
import {
  registerBrowserClientDownloadRouter,
  resetBrowserClientDownloadRouting,
  routeBrowserClientDownload,
  setBrowserClientRouteWebContentsProbe
} from './browser-client-download-routing'
import { BrowserClientFileChannelTransport } from './browser-client-file-channel-transport'

const ENV_A_GUEST_ID = 21
const ENV_B_GUEST_ID = 22

function pageOf(environment: string): BrowserClientHostedPageInventory {
  return {
    authorityRuntimeId: `runtime-${environment}`,
    authorityEpoch: `epoch-${environment}`,
    browserHostClientId: `host-${environment}`,
    browserHostGeneration: 1,
    browserPageId: `page-${environment}`,
    pageHostGeneration: 1,
    browserProfileId: `profile-${environment}`,
    executionHostKey: `host-key-${environment}`,
    state: 'active'
  }
}

type EnvironmentHarness = {
  relay: BrowserClientDownloadRelay
  writes: { browserPageId: string; hostLabel: string }[]
}

function environment(input: {
  environmentId: string
  guestWebContentsId: number
}): EnvironmentHarness {
  const writes: { browserPageId: string; hostLabel: string }[] = []
  const transport = new BrowserClientFileChannelTransport()
  transport.bind({
    fileChannelNegotiated: true,
    fileChannelAvailability: 'negotiated',
    sendFileChannelRequest: async (_method, params) => {
      writes.push({
        browserPageId: (params as { browserPageId: string }).browserPageId,
        hostLabel: input.environmentId
      })
      return {
        ok: true,
        result: {
          accepted: true,
          workspaceRelativePath: `.orca/browser-downloads/${input.environmentId}.bin`
        },
        _meta: {}
      } as never
    }
  })
  const page = pageOf(input.environmentId)
  const relay = new BrowserClientDownloadRelay({
    stagingRoot: `/tmp/${input.environmentId}`,
    hostLabel: input.environmentId,
    transport,
    resolvePage: (webContentsId) => (webContentsId === input.guestWebContentsId ? page : undefined),
    filesystem: {
      mkdirSync: () => {},
      removeDirectorySync: () => {},
      readChunks: async function* () {},
      size: async () => 0,
      removeDirectory: async () => {}
    }
  })
  registerBrowserClientDownloadRouter(input.environmentId, relay)
  return { relay, writes }
}

afterEach(() => {
  resetBrowserClientDownloadRouting()
})

describe('client-hosted download routing', () => {
  it('routes each environment through the composition that owns the page', async () => {
    const envA = environment({ environmentId: 'env-a', guestWebContentsId: ENV_A_GUEST_ID })
    const envB = environment({ environmentId: 'env-b', guestWebContentsId: ENV_B_GUEST_ID })
    setBrowserClientRouteWebContentsProbe(() => true)

    const decisionA = routeBrowserClientDownload({ guestWebContentsId: ENV_A_GUEST_ID })
    const decisionB = routeBrowserClientDownload({ guestWebContentsId: ENV_B_GUEST_ID })

    expect(decisionA.kind).toBe('remote')
    expect(decisionB.kind).toBe('remote')
    if (decisionA.kind !== 'remote' || decisionB.kind !== 'remote') {
      return
    }
    expect(decisionA.route.browserPageId).toBe('page-env-a')
    expect(decisionB.route.browserPageId).toBe('page-env-b')

    await decisionA.route.complete('a.bin')

    expect(envA.writes).toEqual([{ browserPageId: 'page-env-a', hostLabel: 'env-a' }])
    expect(envB.writes).toEqual([])
  })
})
