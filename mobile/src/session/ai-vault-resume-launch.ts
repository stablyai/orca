import { RESUME_RPC_TIMEOUT_MS } from './ai-vault-resume-preparation'
import type { MobileAiVaultResumeLaunch } from '../../../src/shared/mobile-ai-vault-resume-launch-plan'
import type { RpcClient } from '../transport/rpc-client'
import {
  readMobileReviewCreatedTerminal,
  readMobileReviewTerminalSendAccepted,
  type MobileReviewTerminalTab
} from './mobile-diff-review-rpc'

export async function resumeAiVaultSessionInTerminal(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  launch: MobileAiVaultResumeLaunch & { clientMutationId?: string },
  assertCurrent: () => void = () => {}
): Promise<MobileReviewTerminalTab> {
  assertCurrent()
  const created = await client.sendRequest(
    'session.tabs.createTerminal',
    {
      worktree: `id:${worktreeId}`,
      ...(launch.env ? { env: launch.env } : {}),
      ...(launch.envToDelete ? { envToDelete: launch.envToDelete } : {}),
      ...(launch.launchConfig ? { launchConfig: launch.launchConfig } : {}),
      ...(launch.launchAgent ? { launchAgent: launch.launchAgent } : {}),
      ...(launch.clientMutationId ? { clientMutationId: launch.clientMutationId } : {}),
      activate: false,
      select: true,
      navigation: 'caller'
    },
    { timeoutMs: RESUME_RPC_TIMEOUT_MS }
  )
  if (!created.ok) {
    throw new Error(created.error?.message || 'Failed to create terminal')
  }
  const terminalTab = readMobileReviewCreatedTerminal(created.result)
  if (!terminalTab) {
    throw new Error('Created terminal response was invalid')
  }
  assertCurrent()
  const sent = await client.sendRequest(
    'terminal.send',
    {
      terminal: terminalTab.terminal,
      text: launch.command,
      enter: true
    },
    { timeoutMs: RESUME_RPC_TIMEOUT_MS }
  )
  if (!sent.ok) {
    throw new Error(sent.error?.message || 'Failed to send resume command')
  }
  if (!readMobileReviewTerminalSendAccepted(sent.result)) {
    throw new Error('Terminal input is locked')
  }
  return terminalTab
}
