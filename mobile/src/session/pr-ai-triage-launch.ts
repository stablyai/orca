import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import { reviewTerminalCreateRun, reviewTerminalSendRun } from './mobile-review-terminal-operations'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'

// Pure launch path for the PR triage actions ("Fix checks with AI" / "Resolve
// conflicts with AI"). Reuses the same two RPCs the diff-review send flow uses —
// session.tabs.createTerminal then terminal.send — so the prompt is dropped into a
// fresh agent terminal in the worktree. Kept free of react-native imports so it
// stays unit-testable in the node test environment.
export async function createTerminalAndSendPrompt(
  client: RpcOperationSender,
  worktreeId: string,
  prompt: string
): Promise<void> {
  // Each request is awaited outside its catch so a transport drop propagates as the original
  // error object; only a refusal is rewritten into the step's own copy.
  const createdReply = await reviewTerminalCreateRun.request(client, {
    worktree: `id:${worktreeId}`,
    activate: false,
    select: true,
    navigation: 'caller'
  })
  let terminalTab
  try {
    terminalTab = reviewTerminalCreateRun.interpret(createdReply)
  } catch (error) {
    throw new Error(refusedRpcMessageOrFallback(error, 'Failed to create terminal'))
  }
  const sentReply = await reviewTerminalSendRun.request(client, {
    terminal: terminalTab.terminal,
    text: prompt,
    enter: true
  })
  let accepted
  try {
    accepted = reviewTerminalSendRun.interpret(sentReply)
  } catch (error) {
    throw new Error(refusedRpcMessageOrFallback(error, 'Failed to send prompt'))
  }
  if (!accepted) {
    throw new Error('Terminal input is locked')
  }
}
