import type { RpcClient } from '../transport/rpc-client'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import type { MobileReviewTerminalTab } from './mobile-diff-review-rpc'

const RESUME_TITLE_RPC_TIMEOUT_MS = 5_000

export async function applyMobileAiVaultResumeTitle(
  client: Pick<RpcClient, 'sendRequest'>,
  terminal: MobileReviewTerminalTab,
  title: string | undefined
): Promise<MobileReviewTerminalTab> {
  const normalizedTitle = title?.trim()
  if (!normalizedTitle) {
    return terminal
  }
  const rename = async (): Promise<MobileReviewTerminalTab> => {
    const renamed = await client.sendRequest(
      'terminal.rename',
      { terminal: terminal.terminal, title: normalizedTitle },
      { timeoutMs: RESUME_TITLE_RPC_TIMEOUT_MS, failWhenDisconnected: true }
    )
    return renamed.ok ? { ...terminal, title: normalizedTitle } : terminal
  }
  try {
    return await rename()
  } catch (error) {
    // A cosmetic failure must not retry an agent launch that already succeeded.
    // Renaming itself is idempotent, so a logical-client cutover may safely
    // repeat only this request once on the replacement connection.
    if (!isLogicalClientCutoverError(error)) {
      return terminal
    }
    try {
      return await rename()
    } catch {
      return terminal
    }
  }
}
