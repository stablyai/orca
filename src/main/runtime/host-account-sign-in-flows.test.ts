import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostAccountSignInChannel } from '../../shared/host-account-sign-in-types'
import { HostAccountSignInFlows, type HostAccountSignInRunner } from './host-account-sign-in-flows'

const CLAUDE_STATE = { accounts: [], activeAccountId: null }
const PROMPT = { url: 'https://claude.com/cai/oauth/authorize?code=true', userCode: null }

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

afterEach(() => {
  vi.useRealTimers()
})

describe('HostAccountSignInFlows', () => {
  it('relays the link to the starting client and the pasted code back to the login', async () => {
    const runner = controllableRunner()
    const flows = new HostAccountSignInFlows(runner.run, 'linux')
    const started = flows.start('device-a', 'claude')
    expect(started.phase).toBe('starting')
    expect(runner.run).toHaveBeenCalledOnce()

    runner.channel().onPrompt({ ...PROMPT, needsCode: true })
    const waiting = await flows.wait('device-a', started.flowId, started.revision)
    expect(waiting).toMatchObject({
      phase: 'waiting',
      prompt: { url: PROMPT.url, needsCode: true }
    })

    const code = runner.channel().nextCode()
    expect(flows.submitCode('device-a', started.flowId, 'abc#state').phase).toBe('verifying')
    await expect(code).resolves.toBe('abc#state')
    expect(() => flows.submitCode('device-a', started.flowId, 'again')).toThrow(
      'not waiting for a code'
    )

    runner.finish.resolve()
    const done = await flows.wait('device-a', started.flowId, waiting.revision + 1)
    expect(done).toMatchObject({ phase: 'signedIn', claude: CLAUDE_STATE })
    expect(done.prompt).toBeUndefined()
  })

  it('keeps one client from reading, answering or cancelling another client’s sign-in', async () => {
    const runner = controllableRunner()
    const flows = new HostAccountSignInFlows(runner.run, 'linux')
    const { flowId } = flows.start('device-a', 'claude')
    expect(() => flows.start('device-b', 'codex')).toThrow('already running on this host')
    await expect(flows.wait('device-b', flowId, 0)).rejects.toThrow('no longer active')
    expect(() => flows.submitCode('device-b', flowId, 'x')).toThrow('no longer active')
    await expect(flows.cancel('device-b', flowId)).rejects.toThrow('no longer active')
    expect(flows.start('device-a', 'claude').flowId).toBe(flowId)
    expect(runner.run).toHaveBeenCalledOnce()
    await flows.cancel('device-a', flowId)
  })

  it('cancels the login and reports cancelled, not the login’s own failure', async () => {
    const runner = controllableRunner()
    const flows = new HostAccountSignInFlows(runner.run, 'linux')
    const { flowId } = flows.start('device-a', 'claude')
    expect(runner.run).toHaveBeenCalledOnce()
    expect((await flows.cancel('device-a', flowId)).phase).toBe('cancelled')
    expect(runner.channel().signal.aborted).toBe(true)
    await expect(runner.channel().nextCode()).rejects.toThrow()
    expect(flows.start('device-a', 'codex').phase).toBe('starting')
    expect((await flows.wait('device-a', flowId, 0).catch((error) => error)).message).toMatch(
      'no longer active'
    )
  })

  it('reports the account a login added after it refused a late cancel', async () => {
    const flows = new HostAccountSignInFlows(async (_provider, channel) => {
      // Once Codex commits login, cancel can be refused and registration still completes.
      await new Promise((resolve) => channel.signal.addEventListener('abort', resolve))
      return { claude: CLAUDE_STATE }
    }, 'linux')
    const { flowId } = flows.start('device-a', 'codex')
    expect(await flows.cancel('device-a', flowId)).toMatchObject({
      phase: 'signedIn',
      claude: CLAUDE_STATE
    })
  })

  it('says another account change stopped it when nobody here cancelled', async () => {
    const flows = new HostAccountSignInFlows(async () => {
      throw new Error('Codex sign-in was cancelled.')
    }, 'linux')
    const { flowId } = flows.start('device-a', 'codex')
    expect(await flows.wait('device-a', flowId, 1)).toMatchObject({
      phase: 'failed',
      error: 'An account change on this host stopped the sign-in. Start it again.',
      errorCode: 'superseded'
    })
  })

  it('ignores a published page that is not the provider’s own sign-in host', async () => {
    const runner = controllableRunner()
    const flows = new HostAccountSignInFlows(runner.run, 'linux')
    const { flowId, revision } = flows.start('device-a', 'claude')
    expect(runner.run).toHaveBeenCalledOnce()
    runner
      .channel()
      .onPrompt({ url: 'https://evil.test/?code=true', userCode: null, needsCode: true })
    expect((await flows.wait('device-a', flowId, 0)).revision).toBe(revision)
    await flows.cancel('device-a', flowId)
  })

  it('reports a failed login with its message, stripped of terminal escapes', async () => {
    const flows = new HostAccountSignInFlows(async () => {
      throw new Error('Codex login failed: \u001b[31mboom\u001b[0m')
    }, 'darwin')
    const { flowId } = flows.start('device-a', 'codex')
    const status = await flows.wait('device-a', flowId, 1)
    expect(status).toMatchObject({ phase: 'failed', error: 'Codex login failed: boom' })
    // The login's own text has no Orca code, so clients show it verbatim.
    expect(status.errorCode).toBeUndefined()
  })

  it('ends a sign-in whose client stopped asking about it', async () => {
    vi.useFakeTimers()
    const runner = controllableRunner()
    const flows = new HostAccountSignInFlows(runner.run, 'linux')
    const { flowId } = flows.start('device-a', 'claude')
    await vi.advanceTimersByTimeAsync(91_000)
    expect(runner.channel().signal.aborted).toBe(true)
    const status = await flows.wait('device-a', flowId, 0)
    expect(status).toMatchObject({ phase: 'failed', error: expect.stringContaining('stopped') })
  })

  it('refuses on a Windows host, whose logins need a console of their own', () => {
    const runner = controllableRunner()
    const flows = new HostAccountSignInFlows(runner.run, 'win32')
    expect(() => flows.start('device-a', 'claude')).toThrow('orca account add')
    expect(runner.run).not.toHaveBeenCalled()
  })
})
