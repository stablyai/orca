import { describe, expect, it, vi } from 'vitest'
import { summarizeToolInput } from '../../../../../src/shared/native-chat/tools/native-chat-tool-summary'

describe('summarizeToolInput', () => {
  it('does not traverse an unbounded tool-input object for a short preview', () => {
    const input: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: 8 }, (_unused, index) => [`key${index}`, index])
    )
    const lateGetter = vi.fn(() => 'should not be read')
    Object.defineProperty(input, 'late', { enumerable: true, get: lateGetter })

    expect(summarizeToolInput(input)).not.toBe('')
    expect(lateGetter).not.toHaveBeenCalled()
  })
})
