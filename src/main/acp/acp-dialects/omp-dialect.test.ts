import { describe, expect, it } from 'vitest'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import { OMP_ACP_DIALECT } from './omp-dialect'

const text = (value: string) => ({
  type: 'content' as const,
  content: { type: 'text' as const, text: value }
})
const normalize = (update: ToolCallUpdate) => OMP_ACP_DIALECT.normalizeToolUpdate!(update)

describe('OMP tool updates', () => {
  it('leaves a tool without a command echo as it came', () => {
    const update: ToolCallUpdate = {
      toolCallId: 'call-1',
      status: 'completed',
      rawOutput: { content: [{ type: 'text', text: 'file body' }], details: {} },
      content: [text('file body')]
    }
    expect(normalize(update)).toBe(update)
  })

  it('keeps a result that itself starts with "$ "', () => {
    const update: ToolCallUpdate = {
      toolCallId: 'call-1',
      status: 'completed',
      rawOutput: { content: [{ type: 'text', text: '$ 5.00' }], details: {} },
      content: [text('$ 5.00')]
    }
    expect(normalize(update)).toBe(update)
  })

  it('keeps output that only looks like a notice when OMP sent no matching detail', () => {
    const update = normalize({
      toolCallId: 'call-1',
      status: 'completed',
      rawOutput: {
        content: [{ type: 'text', text: 'done\n\nCommand exited with code 3' }],
        details: {}
      },
      content: [text('$ ./run'), text('done\n\nCommand exited with code 3')]
    })
    expect(update).toMatchObject({
      content: [],
      rawOutput: { stdout: 'done\n\nCommand exited with code 3' }
    })
    expect(update.rawOutput).not.toHaveProperty('exitCode')
  })
})
