import { describe, expect, it } from 'vitest'
import {
  requestRemoteWorktreeSleep,
  type RemoteWorkspaceCall
} from './remote-workspace-terminal-sleep'

const noTerminals = { terminals: [], totalCount: 0, truncated: false }

/** A paired server answering by method; a function answer runs per call. */
function server(answers: Record<string, unknown>) {
  const methods: string[] = []
  const call: RemoteWorkspaceCall = async (method) => {
    methods.push(method)
    const answer = answers[method]
    return typeof answer === 'function' ? answer() : answer
  }
  return { call, methods }
}

const notFound = () => {
  throw Object.assign(new Error('unknown method'), { code: 'method_not_found' })
}

describe('requestRemoteWorktreeSleep', () => {
  it('stops an older server and polls until no terminal is live', async () => {
    const { call, methods } = server({
      'terminal.sleep': notFound,
      'terminal.stop': {},
      'terminal.list': noTerminals
    })
    expect(await requestRemoteWorktreeSleep(call, 'r::/w')).toEqual([])
    expect(methods).toEqual(['terminal.sleep', 'terminal.stop', 'terminal.list'])
  })

  it('takes no legacy path for any other refusal', async () => {
    const { call, methods } = server({
      'terminal.sleep': () => {
        throw Object.assign(new Error('denied'), { code: 'forbidden' })
      }
    })
    await expect(requestRemoteWorktreeSleep(call, 'r::/w')).rejects.toThrow('denied')
    expect(methods).toEqual(['terminal.sleep'])
  })
})
