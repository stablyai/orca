import { describe, expect, it } from 'vitest'
import { SystemSshOutputTail } from './system-ssh-output-tail'

describe('SystemSshOutputTail', () => {
  it('preserves ordinary output exactly', () => {
    const output = new SystemSshOutputTail(16)
    output.push('first ')
    output.push(Buffer.from('second'))

    expect(output.toString()).toBe('first second')
  })

  it('keeps only the newest bytes after many chunks', () => {
    const output = new SystemSshOutputTail(8)
    for (const chunk of ['123', '456', '789', 'tail']) {
      output.push(chunk)
    }

    expect(output.toString()).toBe('[earlier system SSH output truncated]\n6789tail')
  })

  it('copies a bounded slice instead of retaining a large chunk backing buffer', () => {
    const output = new SystemSshOutputTail(4)
    const large = Buffer.from('discard-prefix-tail')
    output.push(large)
    large.fill(0)

    expect(output.toString()).toBe('[earlier system SSH output truncated]\ntail')
  })
})
