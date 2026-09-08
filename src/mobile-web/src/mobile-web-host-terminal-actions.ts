import type { MobileWebTerminalRequest } from '../../shared/mobile-web/terminal-stream-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { requestMobileWebHost } from './mobile-web-host-request-client'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

type MetadataOperation = 'displayMode' | 'clear' | 'rename'
export type MobileWebTerminalMetadataRequest = {
  [Operation in MetadataOperation]: Omit<
    Extract<MobileWebTerminalRequest, { operation: Operation }>,
    'streamId'
  >
}[MetadataOperation]
export type MobileWebTerminalMetadataAction = (
  request: MobileWebTerminalMetadataRequest
) => Promise<null>

const HOST_METHODS: Record<MetadataOperation, string> = {
  displayMode: 'terminal.setDisplayMode',
  clear: 'terminal.clearBuffer',
  rename: 'terminal.rename'
}

export function mobileWebHostTerminalActions(
  requests: MobileWebOneShotRequestClient,
  workspaceId: string,
  tabId: string,
  signal: AbortSignal
): MobileWebTerminalMetadataAction {
  return async ({ operation, ...fields }) => {
    // A missing acknowledgement may hide a committed action; never retry an ambiguous mutation.
    const result = await requestMobileWebHost(
      requests,
      'mobileWeb.terminal.action',
      workspaceId,
      { tabId, method: HOST_METHODS[operation], fields, timeoutMs: 15_000 },
      { signal }
    )
    if (
      typeof result !== 'object' ||
      result === null ||
      !('applied' in result) ||
      result.applied !== true
    ) {
      throw new MobileWebBridgeClientError('invalid_message', false)
    }
    return null
  }
}
