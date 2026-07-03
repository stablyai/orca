import type { RpcClient } from '../transport/rpc-client'
import {
  readMobileReviewCreatedTerminal,
  readMobileReviewTerminalSendAccepted
} from './mobile-diff-review-rpc'

// Pure launch path for the PR triage actions ("Fix checks with AI" / "Resolve
// conflicts with AI"). Reuses the same two RPCs the diff-review send flow uses —
// session.tabs.createTerminal then terminal.send — so the prompt is dropped into a
// fresh agent terminal in the worktree. There is no higher-level agent-composer RPC
// on mobile, so this createTerminal+send pair is the launch mechanism. Kept free of
// react-native imports so it stays unit-testable in the node test environment.
export async function createTerminalAndSendPrompt(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  prompt: string
): Promise<void> {
  const created = await client.sendRequest('session.tabs.createTerminal', {
    worktree: `id:${worktreeId}`
  })
  if (!created.ok) {
    throw new Error(created.error?.message || 'Failed to create terminal')
  }
  const terminalTab = readMobileReviewCreatedTerminal(created.result)
  if (!terminalTab) {
    throw new Error('Created terminal response was invalid')
  }
  const sent = await client.sendRequest('terminal.send', {
    terminal: terminalTab.terminal,
    text: prompt,
    enter: true
  })
  if (!sent.ok) {
    throw new Error(sent.error?.message || 'Failed to send prompt')
  }
  if (!readMobileReviewTerminalSendAccepted(sent.result)) {
    throw new Error('Terminal input is locked')
  }
}
