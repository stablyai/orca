import { describe, expect, it, vi } from 'vitest'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import { WRITE_ACCEPTED } from '../../shared/pty-write-settlement'

function createAdapter() {
  let exitListener: ((event: { id: string; code: number; incarnationId?: string }) => void) | null =
    null
  const adapter = {
    hasPty: vi.fn((id: string) => id === 'pty-1'),
    write: vi.fn(() => true),
    writeWithSettlement: vi.fn(async () => WRITE_ACCEPTED),
    onData: vi.fn(() => () => {}),
    onExit: vi.fn((listener) => {
      exitListener = listener
      return () => {
        exitListener = null
      }
    }),
    onDaemonIdentityChanged: vi.fn(() => () => {})
  } as unknown as DaemonPtyAdapter
  return {
    adapter,
    exit: () => exitListener?.({ id: 'pty-1', code: 0, incarnationId: 'incarnation-1' })
  }
}

describe('DaemonPtyRouter ownership-transfer input fence', () => {
  it('blocks both write paths until release or physical exit', async () => {
    const current = createAdapter()
    const router = new DaemonPtyRouter({ current: current.adapter, legacy: [] })

    router.setInputFenced('pty-1', true)
    expect(router.write('pty-1', 'blocked')).toBe(false)
    await expect(router.writeWithSettlement('pty-1', 'also-blocked')).resolves.toEqual({
      outcome: 'refused',
      reason: 'write_gate_denied'
    })
    expect(router.writeOwnershipTransferInput('pty-1', 'transferred')).toBe(true)
    expect(current.adapter.write).toHaveBeenCalledOnce()
    expect(current.adapter.write).toHaveBeenCalledWith('pty-1', 'transferred')
    expect(current.adapter.writeWithSettlement).not.toHaveBeenCalled()

    router.setInputFenced('pty-1', false)
    expect(router.writeOwnershipTransferInput('pty-1', 'not-fenced')).toBe(false)
    expect(router.write('pty-1', 'accepted')).toBe(true)

    router.setInputFenced('pty-1', true)
    current.exit()
    expect(router.write('pty-1', 'after-exit')).toBe(true)
  })
})
