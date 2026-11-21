import { expect, it } from 'vitest'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import { HERMES_ACP_DIALECT } from './hermes-dialect'

const text = (value: string) => ({
  type: 'content' as const,
  content: { type: 'text' as const, text: value }
})

// Captured from Hermes 0.23.1 running `echo hi; exit 3` through its terminal tool.
const CALL: ToolCallUpdate = {
  toolCallId: 'call_1',
  title: 'terminal: echo hi + 1 command',
  kind: 'execute',
  locations: [],
  content: [text('$ echo hi; exit 3')]
}
const RESULT: ToolCallUpdate = {
  toolCallId: 'call_1',
  kind: 'execute',
  status: 'failed',
  content: [text('terminal result\n- **output:** hi\n- **exit_code:** 3')]
}

it("reads a terminal call's command from its preview and names the tool, not the preview", () => {
  const call = HERMES_ACP_DIALECT.normalizeToolUpdate!(CALL)
  expect(call.rawInput).toEqual({ command: 'echo hi; exit 3' })
  expect(call.content).toEqual([])
  expect(HERMES_ACP_DIALECT.toolName!(CALL)).toBe('terminal')
})

it('reads a terminal result as output and exit code', () => {
  expect(HERMES_ACP_DIALECT.normalizeToolUpdate!(RESULT)).toMatchObject({
    rawOutput: { stdout: 'hi', exitCode: 3 },
    content: []
  })
  const silent = {
    ...RESULT,
    status: 'completed' as const,
    content: [
      text(
        'terminal result\n- **exit_code:** 0\n- **approval:** Command required approval (recursive delete) and was approved by the user.'
      )
    ]
  }
  expect(HERMES_ACP_DIALECT.normalizeToolUpdate!(silent).rawOutput).toEqual({
    stdout: '',
    exitCode: 0
  })
})

it('keeps a terminal result whose output prints an exit-code line of its own', () => {
  const printed = {
    ...RESULT,
    content: [
      text('terminal result\n- **output:** foo\n- **exit_code:** 0\nrest\n- **exit_code:** 3')
    ]
  }
  expect(HERMES_ACP_DIALECT.normalizeToolUpdate!(printed)).toBe(printed)
})

it('keeps a terminal result that says where its truncated output was saved', () => {
  const spilled = {
    ...RESULT,
    content: [
      text(
        'terminal result\n- **output:** head\n- **exit_code:** 0\n- **full_output_path:** /tmp/out.log\n- **truncation_note:** output truncated'
      )
    ]
  }
  expect(HERMES_ACP_DIALECT.normalizeToolUpdate!(spilled)).toBe(spilled)
})
