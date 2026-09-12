import { describe, expect, it } from 'vitest'
import { PtyOwnershipTransferInputFence } from './pty-ownership-transfer-input-fence'

describe('PtyOwnershipTransferInputFence', () => {
  it('blocks only known terminals until release or physical exit', () => {
    const fence = new PtyOwnershipTransferInputFence()

    fence.set('unknown', true, false)
    expect(fence.permits('unknown')).toBe(true)

    fence.set('pty-1', true, true)
    expect(fence.permits('pty-1')).toBe(false)
    fence.set('pty-1', false, true)
    expect(fence.permits('pty-1')).toBe(true)

    fence.set('pty-1', true, true)
    fence.remove('pty-1')
    expect(fence.permits('pty-1')).toBe(true)
  })
})
