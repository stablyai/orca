import { describe, expect, it } from 'vitest'
import {
  requestRemoteWorktreeSleep,
  type RemoteWorkspaceCall
} from './remote-workspace-terminal-sleep'

const verified = {
  stopped: 1,
  stoppedPtyIds: ['pty-1'],
  livePtyIds: ['pty-1'],
  postStopVerified: true
}
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
  it("returns the server's stopped handles once it proves the stop", async () => {
    const { call } = server({ 'terminal.sleep': verified })
    expect(await requestRemoteWorktreeSleep(call, 'r::/w')).toEqual(['pty-1'])
  })

  it('names a terminal the server still sees live', async () => {
    const { call } = server({
      'terminal.sleep': {
        ...verified,
        postStopVerified: false,
        postStopFailure: 'terminal_worktree_sleep_still_live',
        remainingLivePtyIds: ['pty-1']
      }
    })
    await expect(requestRemoteWorktreeSleep(call, 'r::/w')).rejects.toThrow(
      'terminal_worktree_sleep_still_live'
    )
  })

  it.each([null, {}, { postStopVerified: 'yes' }, { ...verified, remainingLivePtyIds: 'pty-1' }])(
    'refuses a malformed answer %#',
    async (answer) => {
      const { call } = server({ 'terminal.sleep': answer })
      await expect(requestRemoteWorktreeSleep(call, 'r::/w')).rejects.toThrow(
        'terminal_worktree_sleep_invalid_response'
      )
    }
  )

  it('stops an older server and polls until no terminal is live', async () => {
    const { call, methods } = server({
      'terminal.sleep': notFound,
      'terminal.stop': {},
      'terminal.list': noTerminals
    })
    expect(await requestRemoteWorktreeSleep(call, 'r::/w')).toEqual([])
    expect(methods).toEqual(['terminal.sleep', 'terminal.stop', 'terminal.list'])
  })

  it('keeps an older server unconfirmed while its listing is truncated or malformed', async () => {
    const { call } = server({
      'terminal.sleep': notFound,
      'terminal.stop': {},
      'terminal.list': { ...noTerminals, truncated: true }
    })
    await expect(requestRemoteWorktreeSleep(call, 'r::/w')).rejects.toThrow(
      'terminal_worktree_sleep_legacy_unverified'
    )
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
