import { describe, expect, it } from 'vitest'
import { KIMI_ACP_DIALECT } from './kimi-dialect'

const normalize = KIMI_ACP_DIALECT.normalizeToolUpdate!

const text = (value: string) => ({
  type: 'content' as const,
  content: { type: 'text' as const, text: value }
})

// Payloads recorded from Kimi Code 2.6.0 over `kimi acp`.
describe('KIMI_ACP_DIALECT.normalizeToolUpdate', () => {
  it('reads a failed command as output and exit code', () => {
    const output = 'hello-from-kimi\nCommand failed with exit code: 3.'
    const update = normalize({
      toolCallId: '0:call_1',
      status: 'failed',
      content: [text(output)],
      rawOutput: output
    })
    expect(update.rawOutput).toEqual({ stdout: 'hello-from-kimi', exitCode: 3 })
    expect(update.content).toEqual([])
  })

  it('reads a silent failed command as empty output', () => {
    const output = 'Process exited with code 4\nCommand failed with exit code: 4.'
    const update = normalize({
      toolCallId: '0:call_1',
      status: 'failed',
      content: [text(output)],
      rawOutput: output
    })
    expect(update.rawOutput).toEqual({ stdout: '', exitCode: 4 })
  })

  it('reads a silent successful command as empty output', () => {
    const output = 'Command executed successfully.'
    const update = normalize({
      toolCallId: '0:call_1',
      status: 'completed',
      content: [text(output)],
      rawOutput: output
    })
    expect(update.rawOutput).toEqual({ stdout: '', exitCode: 0 })
  })

  it('keeps successful output that ends like a failure', () => {
    const output = 'log\nCommand failed with exit code: 3.'
    const update = normalize({
      toolCallId: '0:call_1',
      status: 'completed',
      content: [text(output)],
      rawOutput: output
    })
    expect(update.rawOutput).toBe(output)
  })

  it('drops the streamed arguments a running call shows as text', () => {
    const update = normalize({
      toolCallId: '0:call_1',
      status: 'in_progress',
      rawInput: { command: 'echo hi' },
      content: [text('{"command":"echo hi"}')]
    })
    expect(update.content).toEqual([])
  })
})

describe('KIMI_ACP_DIALECT.request', () => {
  it('describes an approval with the action Kimi asks about', () => {
    const presentation = KIMI_ACP_DIALECT.request!('session/request_permission', {
      sessionId: 'session_1',
      options: [{ optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' }],
      toolCall: {
        toolCallId: '0:call_1',
        title: 'Bash',
        content: [text('Requesting approval to Running: rm -rf build')]
      }
    })
    expect(presentation?.body).toMatchObject({
      kind: 'approval',
      title: 'Bash',
      description: 'Running: rm -rf build'
    })
  })
})
