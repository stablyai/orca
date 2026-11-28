import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { ClaudeKeptAgentResponder, claudeHookCallbacksById } from './claude-kept-agent-responder'

const settle = () => new Promise((resolve) => setImmediate(resolve))

function named(name: string): HookCallback {
  const callback: HookCallback = async () => ({ systemMessage: name })
  return callback
}

/** The hook callback ids the real SDK sends in its initialize request for these hooks. */
async function sdkHookIds(hooks: Options['hooks']): Promise<Record<string, string[][]>> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const stdin = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    exitCode: null,
    kill: () => true
  })
  const written = new Promise<string>((resolve) => {
    let text = ''
    stdin.on('data', (chunk: Buffer) => {
      text += chunk.toString()
      const line = text.split('\n').find((each) => each.includes('"initialize"'))
      if (line) {
        resolve(line)
      }
    })
  })
  const session = query({
    prompt: (async function* () {})(),
    options: {
      hooks,
      pathToClaudeCodeExecutable: '/bin/false',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SDK only writes stdin and listens on this stand-in.
      spawnClaudeCodeProcess: () => child as never
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SDK's initialize request shape.
  const request = JSON.parse(await written) as {
    request: { hooks: Record<string, { hookCallbackIds: string[] }[]> }
  }
  session.close()
  return Object.fromEntries(
    Object.entries(request.request.hooks).map(([event, matchers]) => [
      event,
      matchers.map((matcher) => matcher.hookCallbackIds)
    ])
  )
}

describe('ClaudeKeptAgentResponder', () => {
  it('names each hook callback with the id the SDK gave the agent', async () => {
    const hooks: Options['hooks'] = {
      PreToolUse: [{ hooks: [named('pre-a'), named('pre-b')] }, { hooks: [named('pre-c')] }],
      PostToolUse: [{ hooks: [named('post-a')] }]
    }
    const byId = claudeHookCallbacksById(hooks)
    const ids = await sdkHookIds(hooks)
    const resolved = Object.values(ids)
      .flat(2)
      .map(async (id) => {
        const callback = byId.get(id)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these callbacks ignore their arguments.
        const output = await callback?.({} as never, undefined, {
          signal: new AbortController().signal
        })
        return output && 'systemMessage' in output ? output.systemMessage : undefined
      })
    expect(await Promise.all(resolved)).toEqual(['pre-a', 'pre-b', 'pre-c', 'post-a'])
  })

  it('answers an approval in the SDK wire shape, and a cancelled one not at all', async () => {
    const lines: string[] = []
    const answers: ((allow: boolean) => void)[] = []
    const responder = new ClaudeKeptAgentResponder(
      {
        canUseTool: (_tool, input) =>
          new Promise((resolve) =>
            answers.push((allow) =>
              resolve(
                allow
                  ? { behavior: 'allow', updatedInput: input }
                  : { behavior: 'deny', message: 'no' }
              )
            )
          )
      },
      undefined,
      (line) => lines.push(line)
    )
    const ask = (id: string) => ({
      type: 'control_request',
      request_id: id,
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'ls' },
        tool_use_id: `tu-${id}`
      }
    })
    expect(responder.observe(ask('r1'))).toBe(true)
    // A held request re-sent on reattach is the same request, asked once.
    expect(responder.observe(ask('r1'))).toBe(true)
    responder.observe(ask('r2'))
    responder.observe({ type: 'control_cancel_request', request_id: 'r2' })
    expect(answers).toHaveLength(2)
    answers[1](true)
    answers[0](true)
    await settle()
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'r1',
          response: { behavior: 'allow', updatedInput: { command: 'ls' }, toolUseID: 'tu-r1' }
        }
      }
    ])
    expect(responder.observe({ type: 'assistant' })).toBe(false)
  })
})
