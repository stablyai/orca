import { describe, expect, it, vi } from 'vitest'
import { AGENT_LAUNCH_PROMPT_UNCONFIRMED_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import type { RpcContext } from '../core'
import { agentLaunchSurfaceFactory } from './agent-launch-surfaces'

// A launch whose prompt text was written but whose Enter was not confirmed: the receipt must
// never say "not delivered", or the caller would offer to send the prompt a second time.
function deliverPartly(clientCapabilities?: string[]) {
  const runtime = {
    deliverStartupFollowup: vi.fn(
      async (
        _handle: string,
        _prompt: unknown,
        options: { onRefused?: (certainty: 'not-sent' | 'unconfirmed') => void }
      ) => {
        options.onRefused?.('unconfirmed')
        return false
      }
    )
  }
  // SAFETY: only deliverTerminalPrompt runs, and it reads the runtime and client fields above.
  const context = {
    runtime,
    clientKind: 'mobile',
    clientCapabilities
  } as unknown as RpcContext
  return agentLaunchSurfaceFactory(context).deliverTerminalPrompt!({
    handle: 'h',
    agent: 'claude',
    freshLaunch: true,
    prompt: { text: 'fix the build', delivery: 'submit' }
  })
}

describe('a launch prompt written without a confirmed submit', () => {
  it('is reported unconfirmed to a client that reads the word', async () => {
    await expect(deliverPartly([AGENT_LAUNCH_PROMPT_UNCONFIRMED_RUNTIME_CAPABILITY])).resolves.toBe(
      'unconfirmed'
    )
  })

  it('is reported handed to the terminal to an older client, never as not delivered', async () => {
    await expect(deliverPartly([])).resolves.toBe(true)
  })
})
