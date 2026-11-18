import { describe, expect, it } from 'vitest'
import { CallerOwnedSignInFlows } from './caller-owned-sign-in-flows'

type Prompt = { state: string }

function flows() {
  return new CallerOwnedSignInFlows<'p', Prompt, string, { got: string }, string>(
    async (_provider, channel, state) => {
      channel.onPrompt({ state: state ?? '' })
      return { got: await channel.nextCode() }
    },
    {
      acceptsPrompt: () => true,
      acceptsCode: (prompt) => prompt !== undefined,
      describeFailure: (message) => ({ error: message }),
      busyMessage: 'busy',
      // Each flow checks a code against its own prompt.
      readCode: (prompt, code) => {
        if (!code.startsWith(`${prompt?.state}:`)) {
          throw new Error('not this sign-in')
        }
        return code.slice(code.indexOf(':') + 1)
      }
    }
  )
}

describe('caller-owned sign-in flows', () => {
  it("checks a code against its own flow's prompt and refuses another flow's without spending", async () => {
    const signIns = flows()
    const first = signIns.start('a', 'p', 'one')
    await signIns.wait('a', first.flowId, 0)
    await signIns.cancel('a', first.flowId)

    const second = signIns.start('b', 'p', 'two')
    const waiting = await signIns.wait('b', second.flowId, 0)
    expect(waiting.prompt).toEqual({ state: 'two' })
    expect(() => signIns.submitCode('b', second.flowId, 'one:code')).toThrow('not this sign-in')
    signIns.submitCode('b', second.flowId, 'two:code')
    let status = await signIns.wait('b', second.flowId, waiting.revision)
    while (status.phase === 'verifying') {
      status = await signIns.wait('b', second.flowId, status.revision)
    }
    expect(status).toMatchObject({ phase: 'signedIn', got: 'code' })
  })
})
