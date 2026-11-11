import { describe, expect, it, vi } from 'vitest'
import { PROCESS_BOUNDARY_GROUND } from '../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'
import { TerminalShellRecoveryBarrier } from '../terminal-shell-recovery-barrier'
import type { PtyIngressEmission } from '../../../../shared/terminal/pty/ingress/pty-startup-ingress-contract'

const TRIGGER = '\x1b[?1049hTUI\x1b]133;D;137\x07'
const MARK = '\x1b]133;D;137\x07'
const HEAD = TRIGGER.slice(0, -MARK.length)
const GROUNDED = `${MARK}${PROCESS_BOUNDARY_GROUND}`

function passthrough(data: string, rawStartSeq = 0): PtyIngressEmission {
  return { data, rawStartSeq, rawEndSeq: rawStartSeq + data.length, transformed: false }
}

function createBarrier(opts?: {
  confirm?: () => Promise<boolean>
  isAlive?: () => boolean
  maxQueuedBytes?: number
  maxPendingMs?: number
}) {
  const released: PtyIngressEmission[] = []
  const confirm = vi.fn(opts?.confirm ?? (async () => true))
  const barrier = new TerminalShellRecoveryBarrier({
    confirmShellForeground: confirm,
    release: (emission) => released.push(emission),
    isAlive: opts?.isAlive ?? (() => true),
    ...(opts?.maxQueuedBytes !== undefined ? { maxQueuedBytes: opts.maxQueuedBytes } : {}),
    ...(opts?.maxPendingMs !== undefined ? { maxPendingMs: opts.maxPendingMs } : {})
  })
  return { barrier, released, confirm }
}

describe('TerminalShellRecoveryBarrier', () => {
  it('pauses at the unclean-death boundary and delivers the queued prompt after the injected reset', async () => {
    let resolveConfirm: ((confirmed: boolean) => void) | undefined
    const { barrier, released, confirm } = createBarrier({
      confirm: () => new Promise((resolve) => void (resolveConfirm = resolve))
    })

    barrier.accept(passthrough(`${TRIGGER}SHELL-PROMPT`, 100))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(released).toEqual([
      { data: HEAD, rawStartSeq: 100, rawEndSeq: 100 + HEAD.length, transformed: false }
    ])

    resolveConfirm?.(true)
    await vi.waitFor(() => expect(released).toHaveLength(3))
    expect(released[1]).toEqual({
      data: GROUNDED,
      rawStartSeq: 100 + HEAD.length,
      rawEndSeq: 100 + TRIGGER.length,
      transformed: true
    })
    expect(released[2]).toEqual({
      data: 'SHELL-PROMPT',
      rawStartSeq: 100 + TRIGGER.length,
      rawEndSeq: 100 + TRIGGER.length + 'SHELL-PROMPT'.length,
      transformed: false
    })
    expect(barrier.getOwner()).toBe('shell')
  })

  it('flushes unmodified with no injection when the proof is refuted', async () => {
    let resolveConfirm: ((confirmed: boolean) => void) | undefined
    const { barrier, released } = createBarrier({
      confirm: () => new Promise((resolve) => void (resolveConfirm = resolve))
    })

    barrier.accept(passthrough(`${TRIGGER}nested-shell`))
    resolveConfirm?.(false)

    await vi.waitFor(() => expect(released).toHaveLength(3))
    expect(released.map((emission) => emission.data)).toEqual([HEAD, MARK, 'nested-shell'])
    expect(barrier.getOwner()).toBeUndefined()
  })

  it('bails out on timeout and ignores a late confirmation', async () => {
    let resolveConfirm: ((confirmed: boolean) => void) | undefined
    const { barrier, released } = createBarrier({
      confirm: () => new Promise((resolve) => void (resolveConfirm = resolve)),
      maxPendingMs: 20
    })

    barrier.accept(passthrough(`${TRIGGER}prompt`))
    await vi.waitFor(() => expect(released).toHaveLength(3))
    expect(released.map((emission) => emission.data)).toEqual([HEAD, MARK, 'prompt'])

    resolveConfirm?.(true)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(released).toHaveLength(3)
    expect(barrier.getOwner()).toBeUndefined()
  })

  it('does not inject when the session died while the proof settled', async () => {
    let resolveConfirm: ((confirmed: boolean) => void) | undefined
    let alive = true
    const { barrier, released } = createBarrier({
      confirm: () => new Promise((resolve) => void (resolveConfirm = resolve)),
      isAlive: () => alive
    })

    barrier.accept(passthrough(`${TRIGGER}prompt`))
    alive = false
    resolveConfirm?.(true)

    await vi.waitFor(() => expect(released).toHaveLength(3))
    expect(released.map((emission) => emission.data)).toEqual([HEAD, MARK, 'prompt'])
    expect(barrier.getOwner()).toBeUndefined()
  })

  it('survives a throwing downstream client without losing the queue or wedging attach', async () => {
    let resolveConfirm: ((confirmed: boolean) => void) | undefined
    const released: PtyIngressEmission[] = []
    const barrier = new TerminalShellRecoveryBarrier({
      confirmShellForeground: () => new Promise((resolve) => void (resolveConfirm = resolve)),
      release: (emission) => {
        if (emission.data === 'poison') {
          throw new Error('client transport died')
        }
        released.push(emission)
      },
      isAlive: () => true
    })

    barrier.accept(passthrough(TRIGGER, 0))
    barrier.accept(passthrough('poison', TRIGGER.length))
    barrier.accept(passthrough('after-poison', TRIGGER.length + 6))
    const settled = barrier.awaitProofSettled()
    resolveConfirm?.(true)

    await settled
    await vi.waitFor(() =>
      expect(released.map((emission) => emission.data)).toEqual([HEAD, GROUNDED, 'after-poison'])
    )
    await expect(barrier.idle()).resolves.toBeUndefined()
  })

  it('grounds a real death D that arrives while a stray D is still being proven', async () => {
    const proofs: ((confirmed: boolean) => void)[] = []
    const { barrier, released, confirm } = createBarrier({
      confirm: () => new Promise((resolve) => void proofs.push(resolve))
    })
    const leak = '\x1b[?1049h\x1b[?1003hTUI\x1b]133;C\x07nested\x1b]133;D;0\x07'

    barrier.accept(passthrough(leak, 0))
    barrier.accept(passthrough('frame\x1b]133;D;137\x07prompt', leak.length))
    proofs[0]?.(false)
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(2))
    proofs[1]?.(true)

    await vi.waitFor(() => expect(barrier.getOwner()).toBe('shell'))
    expect(released.map((emission) => emission.data)).toEqual([
      leak.slice(0, -'\x1b]133;D;0\x07'.length),
      '\x1b]133;D;0\x07',
      'frame',
      GROUNDED,
      'prompt'
    ])
  })

  it('bounds awaitProofSettled by its own deadline when a clean-exit proof hangs', async () => {
    const { barrier } = createBarrier({
      confirm: () => new Promise(() => {}),
      maxPendingMs: 20
    })

    barrier.accept(passthrough('\x1b[?1049hTUI\x1b[?1049l\x1b]133;D;0\x07'))
    const start = Date.now()
    await barrier.awaitProofSettled()
    expect(Date.now() - start).toBeLessThan(500)
    expect(barrier.getOwner()).toBeUndefined()
  })
})
