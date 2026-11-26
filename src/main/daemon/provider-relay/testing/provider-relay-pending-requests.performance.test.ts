import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderRelayPendingRequests } from '../provider-relay-pending-requests'

// #47828: while an ACP prompt is unanswered, tool output quoting "result" must not be parsed on
// the terminal daemon; only lines naming an id can answer a request.
function parsesWhilePrompting(lines: number): number {
  const pending = new ProviderRelayPendingRequests()
  pending.kept.configure({
    answers: ['session/new'],
    lines: ['"sessionUpdate":"config_option_update"'],
    outstanding: ['session/prompt']
  })
  pending.observeClientData(`${JSON.stringify({ id: 7, method: 'session/prompt', params: {} })}\n`)
  const output = JSON.stringify({
    method: 'session/update',
    params: {
      update: { sessionUpdate: 'tool_call_update', rawOutput: [{ result: 'x'.repeat(4096) }] }
    }
  })
  const parse = vi.spyOn(JSON, 'parse')
  for (let seq = 1; seq <= lines; seq += 1) {
    pending.observeAgentLine({ seq, line: output })
  }
  // The envelope scan parses short tokens itself; only a whole-line parse is the cost.
  const parsed = parse.mock.calls.filter(([text]) => text === output).length
  parse.mockRestore()
  return parsed
}

describe('provider relay pending requests while prompting', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses no tool output that only quotes an answer key', () => {
    expect(parsesWhilePrompting(100)).toBe(0)
    expect(parsesWhilePrompting(1000)).toBe(0)
  })

  it('re-parses no held request when the app lets go and no fixed reply can match', () => {
    for (const held of [10, 100]) {
      const pending = new ProviderRelayPendingRequests()
      pending.kept.configure({ answers: [], lines: [], outstanding: ['session/prompt'] })
      pending.toAgent = () => true
      for (let id = 1; id <= held; id += 1) {
        const request = {
          id,
          method: 'session/request_permission',
          params: { x: 'y'.repeat(1024) }
        }
        pending.observeAgentLine({ seq: id, line: JSON.stringify(request) })
      }
      const parse = vi.spyOn(JSON, 'parse')
      for (let release = 0; release < 10; release += 1) {
        pending.answerHeld()
      }
      expect(parse).not.toHaveBeenCalled()
      parse.mockRestore()
      expect(pending.size).toBe(held)
    }
  })
})
