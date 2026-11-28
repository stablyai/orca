import { expect, it } from 'vitest'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import { QODER_ACP_DIALECT } from './qoder-dialect'

const normalize = (update: ToolCallUpdate): ToolCallUpdate =>
  QODER_ACP_DIALECT.normalizeToolUpdate!(update)
const text = (value: string) => ({
  type: 'content' as const,
  content: { type: 'text' as const, text: value }
})

// Frames recorded from qodercli 1.1.100 over ACP.
it('reads Qoder tool results once, with a failed shell call exit code', () => {
  expect(
    normalize({
      toolCallId: 'call_1',
      status: 'pending',
      content: [text('echo hello-orca && ls /nonexistent-dir')],
      rawInput: { command: 'echo hello-orca && ls /nonexistent-dir' }
    })
  ).toEqual({
    toolCallId: 'call_1',
    status: 'pending',
    content: [],
    rawInput: { command: 'echo hello-orca && ls /nonexistent-dir' }
  })

  expect(
    normalize({
      toolCallId: 'call_1',
      status: 'failed',
      content: [
        text('```\nExit code 1\nhello-orca\nls: /nonexistent-dir: No such file or directory\n```')
      ],
      rawOutput: 'Exit code 1\nhello-orca\nls: /nonexistent-dir: No such file or directory'
    })
  ).toEqual({
    toolCallId: 'call_1',
    status: 'failed',
    content: [],
    rawOutput: {
      stdout: 'hello-orca\nls: /nonexistent-dir: No such file or directory',
      exitCode: 1
    }
  })

  expect(
    normalize({
      toolCallId: 'call_2',
      status: 'completed',
      content: [text('```console\nline1\nline2\n```')],
      rawOutput: 'line1\nline2'
    })
  ).toEqual({ toolCallId: 'call_2', status: 'completed', content: [], rawOutput: 'line1\nline2' })

  // A longer fence wraps output that itself holds a fence; other text stays.
  const nested = 'a\n```\nb\n```'
  expect(
    normalize({
      toolCallId: 'call_3',
      status: 'completed',
      content: [text(`\`\`\`\`\n${nested}\n\`\`\`\``), text('note')],
      rawOutput: nested
    }).content
  ).toEqual([text('note')])
})
