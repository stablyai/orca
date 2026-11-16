import { describe, expect, it, vi } from 'vitest'
import type { HostAccountSignInChannel } from '../../../../shared/agent-accounts/host-account-sign-in-types'
import { HostAccountSignInFlows, type HostAccountSignInRunner } from './host-account-sign-in-flows'

const CLAUDE_STATE = { accounts: [], activeAccountId: null }

function controllableRunner() {
  let channel: HostAccountSignInChannel | null = null
  const finish = Promise.withResolvers<void>()
  const run = vi.fn<HostAccountSignInRunner>(async (_provider, received) => {
    channel = received
    received.signal.addEventListener('abort', () =>
      finish.reject(new Error('Claude sign-in was cancelled.'))
    )
    await finish.promise
    return { claude: CLAUDE_STATE }
  })
  return {
    run,
    channel: () => {
      if (!channel) {
        throw new Error('runner not started')
      }
      return channel
    },
    finish
  }
}

describe('HostAccountSignInFlows', () => {
  it('grants the callback port only to the owner of a browser sign-in while it waits', async () => {
    const runner = controllableRunner()
    const flows = new HostAccountSignInFlows(runner.run, 'linux')
    const { flowId } = flows.start('device-a', 'claude', { callback: true })
    expect(runner.channel().callback).toBe(true)
    expect(flows.callbackTarget('device-a', flowId)).toBeNull()
    runner.channel().onPrompt({
      url: 'https://claude.ai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A54121%2Fcallback',
      userCode: null,
      needsCode: true,
      callbackPort: 54121
    })
    expect(flows.callbackTarget('device-a', flowId)?.port).toBe(54121)
    expect(flows.callbackTarget('device-b', flowId)).toBeNull()
    expect(flows.callbackTarget('device-a', 'other-flow')).toBeNull()
    const grant = flows.callbackTarget('device-a', flowId)
    runner.finish.resolve()
    await flows.wait('device-a', flowId, 2)
    expect(grant?.ended.aborted).toBe(true)
    expect(flows.callbackTarget('device-a', flowId)).toBeNull()
  })
})
