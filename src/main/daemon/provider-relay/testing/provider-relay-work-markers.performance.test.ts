import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRelayWorkMarker } from '../../protocol/daemon-provider-relay-protocol'
import { ProviderRelayWorkReader } from '../provider-relay-work-markers'
import { ProviderRelayCarriedWork } from '../../../provider-relay/provider-relay-carried-work'

const UPDATE = ['params', 'update']
// #47828: ACP's call-end marker names `session/update`, the method of every streamed line.
const CALL_END: ProviderRelayWorkMarker = {
  group: 'task',
  name: 'session/update',
  effect: 'end',
  when: [
    { path: [...UPDATE, 'sessionUpdate'], is: 'tool_call_update' },
    { path: [...UPDATE, 'status'], is: 'completed' }
  ],
  key: [[[...UPDATE, 'toolCallId']]]
}

function parsesOfStreamedOutput(lines: number): number {
  const reader = new ProviderRelayWorkReader([CALL_END])
  // Escaped `<`, `>` and `&` in tool output, as Go's encoder writes them.
  const output = JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'in_progress',
        content: [{ type: 'text', text: 'x'.repeat(4096) }]
      }
    }
  }).replace('xxxx', '\\u003c\\u003e\\u0026')
  const parse = vi.spyOn(JSON, 'parse')
  for (let at = 0; at < lines; at += 1) {
    reader.read(output)
  }
  const parsed = parse.mock.calls.filter(([text]) => text === output).length
  parse.mockRestore()
  return parsed
}

describe('provider relay work markers on streamed ACP output', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses no streamed update whose escapes cannot spell a marker value', () => {
    expect(parsesOfStreamedOutput(100)).toBe(0)
    expect(parsesOfStreamedOutput(1000)).toBe(0)
  })

  it('still reads a call end whose status is spelled with escapes', () => {
    const reader = new ProviderRelayWorkReader([CALL_END])
    const line =
      '{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"c\\u006fmpleted"}}}'
    expect(reader.read(line)).toEqual([{ group: 'task', effect: 'end', key: 't1' }])
  })

  it('reads no line for carried work that no marker can end', () => {
    for (const lines of [100, 1000]) {
      const carried = new ProviderRelayCarriedWork([CALL_END])
      // A Droid that may run a subagent carries work nothing ends.
      carried.take({ unknown: [['subagent']] })
      const done = JSON.stringify({
        method: 'session/update',
        params: {
          update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }
        }
      })
      const parse = vi.spyOn(JSON, 'parse')
      for (let at = 0; at < lines; at += 1) {
        carried.observe(done)
      }
      expect(parse.mock.calls.filter(([text]) => text === done)).toHaveLength(0)
      parse.mockRestore()
    }
  })
})
