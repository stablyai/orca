import type { RpcClient } from '../transport/rpc-client'
import {
  readMobileReviewCreatedTerminal,
  readMobileReviewTerminalSendAccepted
} from './mobile-diff-review-rpc'
import { resolveIdentityCreateTerminalParams } from './identity-create-terminal-params'
import { readMobileVaultResumeCreateOutcome } from './ai-vault-resume-outcome'

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
  const createParams = await resolveIdentityCreateTerminalParams(client, worktreeId)
  const created = await client.sendRequest('session.tabs.createTerminal', {
    ...createParams,
    activate: false,
    select: true,
    navigation: 'caller'
  })
  if (!created.ok) {
    throw new Error(created.error?.message || 'Failed to create terminal')
  }
  const terminalTab = readMobileReviewCreatedTerminal(created.result)
  if (!terminalTab) {
    // Why: a success response missing `tab` is the typed pre-spawn agentLaunch
    // failure arm (tombstoned/disabled agent, capacity, ...), not a malformed
    // response — read the failure code like the vault-resume family instead of
    // reporting a generic "invalid response".
    const outcome = readMobileVaultResumeCreateOutcome(created.result)
    throw new Error(
      outcome.kind === 'failed'
        ? `Couldn't start the agent (${outcome.code}).`
        : 'Created terminal response was invalid'
    )
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
