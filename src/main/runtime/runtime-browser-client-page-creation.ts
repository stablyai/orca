import type { BrowserNetworkExecutionHost } from '../../shared/browser-client-host-protocol'
import { BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY } from '../../shared/browser-client-automation-protocol'
import { browserNetworkExecutionHostKey } from '../browser/browser-network-execution-route'
import type { BrowserHostLeaseRegistry } from './browser-host-lease-registry'
import type { RuntimeBrowserClientPlacement } from './browser-host-page-placement'

type RuntimeBrowserClientPageAuthority = Pick<
  BrowserHostLeaseRegistry,
  'authorityRuntimeId' | 'authorityEpoch' | 'createClientPage' | 'issueClientPageCommand'
>

type RuntimeBrowserClientPageCreation = {
  browserPageId: string
  browserHostClientId: string
  pairedDeviceId: string
  browserProfileId: string
  executionHost: BrowserNetworkExecutionHost
  workspaceId?: string
}

type RuntimeBrowserClientPageNavigation = {
  browserPageId: string
  placement: RuntimeBrowserClientPlacement
  url: string
}

type RuntimeBrowserClientPageRetirement = {
  browserPageId: string
  placement: RuntimeBrowserClientPlacement
}

export async function createRuntimeBrowserClientPage(
  authority: RuntimeBrowserClientPageAuthority,
  input: RuntimeBrowserClientPageCreation
): Promise<{ browserPageId: string; placement: RuntimeBrowserClientPlacement }> {
  const placement = await authority.createClientPage({
    browserPageId: input.browserPageId,
    browserHostClientId: input.browserHostClientId,
    pairedDeviceId: input.pairedDeviceId,
    browserProfileId: input.browserProfileId,
    executionHostKey: browserNetworkExecutionHostKey(input.executionHost),
    requiredCapabilities: [BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY],
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {})
  })
  return { browserPageId: input.browserPageId, placement }
}

export async function navigateRuntimeBrowserClientPage(
  authority: RuntimeBrowserClientPageAuthority,
  input: RuntimeBrowserClientPageNavigation
): Promise<void> {
  const issued = authority.issueClientPageCommand(
    {
      authorityRuntimeId: authority.authorityRuntimeId,
      authorityEpoch: authority.authorityEpoch,
      browserPageId: input.browserPageId,
      browserHostClientId: input.placement.browserHostClientId,
      browserHostGeneration: input.placement.browserHostGeneration,
      pageHostGeneration: input.placement.pageHostGeneration
    },
    { type: 'navigate', url: input.url }
  )
  const result = await issued.result
  if (result.status === 'failed') {
    throw new Error(result.errorCode)
  }
}

export async function closeRuntimeBrowserClientPage(
  authority: RuntimeBrowserClientPageAuthority &
    Pick<
      BrowserHostLeaseRegistry,
      'beginPageRetirement' | 'completePageRetirement' | 'requireClientPage'
    >,
  input: RuntimeBrowserClientPageRetirement
): Promise<void> {
  const issued = authority.issueClientPageCommand(
    {
      authorityRuntimeId: authority.authorityRuntimeId,
      authorityEpoch: authority.authorityEpoch,
      browserPageId: input.browserPageId,
      browserHostClientId: input.placement.browserHostClientId,
      browserHostGeneration: input.placement.browserHostGeneration,
      pageHostGeneration: input.placement.pageHostGeneration
    },
    {
      type: 'closePage',
      targetAuthority: {
        authorityRuntimeId: authority.authorityRuntimeId,
        authorityEpoch: authority.authorityEpoch,
        browserHostClientId: input.placement.browserHostClientId,
        browserHostGeneration: input.placement.browserHostGeneration,
        pageHostGeneration: input.placement.pageHostGeneration
      }
    }
  )
  const result = await issued.result
  if (result.status === 'failed') {
    throw new Error(result.errorCode)
  }
  const canonicalPlacement = authority.requireClientPage({
    authorityRuntimeId: authority.authorityRuntimeId,
    authorityEpoch: authority.authorityEpoch,
    browserPageId: input.browserPageId,
    browserHostClientId: input.placement.browserHostClientId,
    browserHostGeneration: input.placement.browserHostGeneration,
    pageHostGeneration: input.placement.pageHostGeneration
  })
  const retirement = authority.beginPageRetirement(input.browserPageId, canonicalPlacement)
  if (!authority.completePageRetirement(retirement)) {
    throw new Error('browser_page_placement_stale')
  }
}
