import { describe, expect, it, vi } from 'vitest'
import { POST_REPLAY_DEAD_TUI_RESET } from '../../shared/terminal-mode-reset-profiles'
import { TerminalShellRecoveryBarrier } from './terminal-shell-recovery-barrier'
import type { PtyIngressEmission } from '../../shared/pty-startup-ingress'

const TRIGGER = '\x1b[?1049hTUI\x1b]133;D;137\x07'

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
  it('releases ordinary output untouched without inspections', () => {
    const { barrier, released, confirm } = createBarrier()
    const emission = passthrough('plain \x1b[31mred\x1b[0m output\r\n')
    barrier.accept(emission)

    expect(released).toEqual([emission])
    expect(confirm).not.toHaveBeenCalled()
    expect(barrier.getOwner()).toBeUndefined()
  })

  it('pauses at the unclean-death boundary and delivers the queued prompt after the injected reset', async () => {
    let resolveConfirm: ((confirmed: boolean) => void) | undefined
    const { barrier, released, confirm } = createBarrier({
      confirm: () => new Promise((resolve) => void (resolveConfirm = resolve))
    })

    barrier.accept(passthrough(`${TRIGGER}SHELL-PROMPT`, 100))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(released).toEqual([
      { data: TRIGGER, rawStartSeq: 100, rawEndSeq: 100 + TRIGGER.length, transformed: false }
    ])

    resolveConfirm?.(true)
    await vi.waitFor(() => expect(released).toHaveLength(3))
    expect(released[1]).toEqual({
      data: POST_REPLAY_DEAD_TUI_RESET,
      rawStartSeq: 100 + TRIGGER.length,
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

  it('queues later emissions during an episode and preserves order', async () => {
    let resolveConfirm: ((confirmed: boolean) => void) | undefined
    const { barrier, released } = createBarrier({
      confirm: () => new Promise((resolve) => void (resolveConfirm = resolve))
    })

    barrier.accept(passthrough(TRIGGER, 0))
    barrier.accept(passthrough('late-1', TRIGGER.length))
    barrier.accept(passthrough('late-2', TRIGGER.length + 6))
    expect(released).toHaveLength(1)

    resolveConfirm?.(true)
    await vi.waitFor(() => expect(released).toHaveLength(4))
    expect(released.map((emission) => emission.data)).toEqual([
      TRIGGER,
      POST_REPLAY_DEAD_TUI_RESET,
      'late-1',
      'late-2'
    ])
  })

  it('flushes unmodified with no injection when the proof is refuted', async () => {
    let resolveConfirm: ((confirmed: boolean) => void) | undefined
    const { barrier, released } = createBarrier({
      confirm: () => new Promise((resolve) => void (resolveConfirm = resolve))
    })

    barrier.accept(passthrough(`${TRIGGER}nested-shell`))
    resolveConfirm?.(false)

    await vi.waitFor(() => expect(released).toHaveLength(2))
    expect(released.map((emission) => emission.data)).toEqual([TRIGGER, 'nested-shell'])
    expect(barrier.getOwner()).toBeUndefined()
  })

  it('bails out on timeout and ignores a late confirmation', async () => {
    let resolveConfirm: ((confirmed: boolean) => void) | undefined
    const { barrier, released } = createBarrier({
      confirm: () => new Promise((resolve) => void (resolveConfirm = resolve)),
      maxPendingMs: 20
    })

    barrier.accept(passthrough(`${TRIGGER}prompt`))
    await vi.waitFor(() => expect(released).toHaveLength(2))
    expect(released.map((emission) => emission.data)).toEqual([TRIGGER, 'prompt'])

    resolveConfirm?.(true)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(released).toHaveLength(2)
    expect(barrier.getOwner()).toBeUndefined()
  })

  it('bails out when the queue exceeds its byte budget', () => {
    const { barrier, released } = createBarrier({
      confirm: () => new Promise(() => {}),
      maxQueuedBytes: 8
    })

    barrier.accept(passthrough(TRIGGER))
    barrier.accept(passthrough('0123456789'))

    expect(released.map((emission) => emission.data)).toEqual([TRIGGER, '0123456789'])
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

    await vi.waitFor(() => expect(released).toHaveLength(2))
    expect(released.map((emission) => emission.data)).toEqual([TRIGGER, 'prompt'])
    expect(barrier.getOwner()).toBeUndefined()
  })

  it('handles a second unclean episode queued behind the first', async () => {
    const confirms: ((confirmed: boolean) => void)[] = []
    const { barrier, released, confirm } = createBarrier({
      confirm: () => new Promise((resolve) => void confirms.push(resolve))
    })

    barrier.accept(passthrough(`${TRIGGER}first-prompt`, 0))
    const second = `\x1b[?1049hAGAIN\x1b]133;D;9\x07second-prompt`
    barrier.accept(passthrough(second, TRIGGER.length + 'first-prompt'.length))

    confirms[0]?.(true)
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(2))
    confirms[1]?.(true)

    await vi.waitFor(() =>
      expect(released.map((emission) => emission.data)).toEqual([
        TRIGGER,
        POST_REPLAY_DEAD_TUI_RESET,
        'first-prompt',
        '\x1b[?1049hAGAIN\x1b]133;D;9\x07',
        POST_REPLAY_DEAD_TUI_RESET,
        'second-prompt'
      ])
    )
    expect(barrier.getOwner()).toBe('shell')
  })

  it('does not re-trigger on the next command-done after an injected recovery', async () => {
    const { barrier, released, confirm } = createBarrier()
    barrier.accept(passthrough(`${TRIGGER}prompt`))
    await vi.waitFor(() => expect(barrier.getOwner()).toBe('shell'))
    expect(confirm).toHaveBeenCalledTimes(1)

    // Why: the injected reset's ?1049l must ground the scanner's alt state;
    // a bare D at the next plain prompt would otherwise loop the repair.
    barrier.accept(passthrough('\x1b]133;C\x07ls\r\n\x1b]133;D;0\x07'))

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(released.at(-1)?.data).toBe('\x1b]133;C\x07ls\r\n\x1b]133;D;0\x07')
  })

  it('proves clean alternate-screen exits without pausing the stream', async () => {
    let resolveConfirm: ((confirmed: boolean) => void) | undefined
    const { barrier, released, confirm } = createBarrier({
      confirm: () => new Promise((resolve) => void (resolveConfirm = resolve))
    })
    const emission = passthrough('\x1b[?1049hTUI\x1b[?1049l\x1b]133;D;0\x07PROMPT')

    barrier.accept(emission)
    expect(released).toEqual([emission])
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(barrier.getOwner()).toBeUndefined()

    resolveConfirm?.(true)
    await vi.waitFor(() => expect(barrier.getOwner()).toBe('shell'))
  })

  it('rejects a clean-exit proof superseded by a later command start', async () => {
    let resolveConfirm: ((confirmed: boolean) => void) | undefined
    const { barrier } = createBarrier({
      confirm: () => new Promise((resolve) => void (resolveConfirm = resolve))
    })

    barrier.accept(passthrough('\x1b[?1049hTUI\x1b[?1049l\x1b]133;D;0\x07'))
    barrier.accept(passthrough('\x1b]133;C\x07LIVE-TUI'))
    resolveConfirm?.(true)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(barrier.getOwner()).toBeUndefined()
  })

  it('revokes proven ownership when a later TUI arms modes', async () => {
    const { barrier } = createBarrier()
    barrier.accept(passthrough(TRIGGER))
    await vi.waitFor(() => expect(barrier.getOwner()).toBe('shell'))

    barrier.accept(passthrough('\x1b[?1003hLIVE'))
    expect(barrier.getOwner()).toBeUndefined()
  })

  it('resolves idle() at each episode boundary', async () => {
    let resolveConfirm: ((confirmed: boolean) => void) | undefined
    const { barrier } = createBarrier({
      confirm: () => new Promise((resolve) => void (resolveConfirm = resolve))
    })

    await expect(barrier.idle()).resolves.toBeUndefined()

    barrier.accept(passthrough(TRIGGER))
    let idled = false
    const idle = barrier.idle().then(() => {
      idled = true
    })
    await Promise.resolve()
    expect(idled).toBe(false)

    resolveConfirm?.(true)
    await idle
  })

  it('skips the episode for a transformed emission it cannot split', () => {
    const { barrier, released, confirm } = createBarrier()
    const emission: PtyIngressEmission = {
      data: `${TRIGGER}prompt`,
      rawStartSeq: 0,
      rawEndSeq: 4,
      transformed: true
    }
    barrier.accept(emission)

    expect(released).toEqual([emission])
    expect(confirm).not.toHaveBeenCalled()
    expect(barrier.getOwner()).toBeUndefined()
  })

  it('recognizes a trigger split across emissions and splits the completing one', async () => {
    const { barrier, released } = createBarrier()
    const head = '\x1b[?1049hTUI\x1b]133;D;1'
    const tail = '37\x07PROMPT'
    barrier.accept(passthrough(head, 0))
    barrier.accept(passthrough(tail, head.length))

    await vi.waitFor(() =>
      expect(released.map((emission) => emission.data)).toEqual([
        head,
        '37\x07',
        POST_REPLAY_DEAD_TUI_RESET,
        'PROMPT'
      ])
    )
    expect(released[1]).toMatchObject({ rawStartSeq: head.length, rawEndSeq: head.length + 3 })
    expect(released[3]).toMatchObject({
      rawStartSeq: head.length + 3,
      rawEndSeq: head.length + tail.length
    })
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
      expect(released.map((emission) => emission.data)).toEqual([
        TRIGGER,
        POST_REPLAY_DEAD_TUI_RESET,
        'after-poison'
      ])
    )
    await expect(barrier.idle()).resolves.toBeUndefined()
  })

  it('opens at most one episode per alternate-screen occupancy after a refuted proof', async () => {
    const { barrier, released, confirm } = createBarrier({ confirm: async () => false })

    barrier.accept(passthrough(`${TRIGGER}prompt`))
    await vi.waitFor(() => expect(released).toHaveLength(2))
    expect(confirm).toHaveBeenCalledTimes(1)

    // Why: the refuted path never scans a reset, so alt stays active — later
    // ordinary prompts must not each re-open a pause-and-inspect episode.
    for (let index = 0; index < 5; index += 1) {
      const prompt = passthrough(`\x1b]133;C\x07ls\r\n\x1b]133;D;0\x07`)
      barrier.accept(prompt)
      expect(released.at(-1)).toBe(prompt)
    }
    expect(confirm).toHaveBeenCalledTimes(1)

    // A fresh alternate-screen entry re-arms recovery.
    barrier.accept(passthrough(`\x1b]133;C\x07\x1b[?1049hAGAIN\x1b]133;D;9\x07`))
    expect(confirm).toHaveBeenCalledTimes(2)
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

  it('still opens the episode when the trigger-carrying head release throws', async () => {
    let resolveConfirm: ((confirmed: boolean) => void) | undefined
    const released: PtyIngressEmission[] = []
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => void (resolveConfirm = resolve)))
    let headThrown = false
    const barrier = new TerminalShellRecoveryBarrier({
      confirmShellForeground: confirm,
      release: (emission) => {
        if (!headThrown && emission.data === TRIGGER) {
          headThrown = true
          throw new Error('client transport died mid-broadcast')
        }
        released.push(emission)
      },
      isAlive: () => true
    })

    barrier.accept(passthrough(`${TRIGGER}SHELL-PROMPT`))
    expect(confirm).toHaveBeenCalledTimes(1)
    resolveConfirm?.(true)

    await vi.waitFor(() =>
      expect(released.map((emission) => emission.data)).toEqual([
        POST_REPLAY_DEAD_TUI_RESET,
        'SHELL-PROMPT'
      ])
    )
    expect(barrier.getOwner()).toBe('shell')
  })

  it('flushes a pending episode synchronously for a teardown snapshot', () => {
    const { barrier, released } = createBarrier({ confirm: () => new Promise(() => {}) })

    barrier.accept(passthrough(`${TRIGGER}prompt`))
    expect(released.map((emission) => emission.data)).toEqual([TRIGGER])

    barrier.flushPending()

    expect(released.map((emission) => emission.data)).toEqual([TRIGGER, 'prompt'])
    expect(barrier.getOwner()).toBeUndefined()
  })

  it('drops queued output only on disposal', () => {
    const { barrier, released } = createBarrier({ confirm: () => new Promise(() => {}) })
    barrier.accept(passthrough(`${TRIGGER}prompt`))
    barrier.dispose()

    expect(released.map((emission) => emission.data)).toEqual([TRIGGER])
    barrier.accept(passthrough('after-dispose'))
    expect(released).toHaveLength(1)
  })
})
