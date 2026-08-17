import { describe, expect, it, vi } from 'vitest'
import type { HerdrTerminalFrame } from './herdr-runtime-contract'
import { waitForFirstHerdrFrame } from './herdr-pty-provider-runtime'
import type { HerdrPtyBinding } from './herdr-pty-types'

function frame(bytes: string, opts: { full?: boolean; seq?: number } = {}): HerdrTerminalFrame {
  return {
    type: 'terminal.frame',
    seq: opts.seq ?? 1,
    encoding: 'ansi',
    width: 80,
    height: 24,
    full: opts.full ?? true,
    bytes: Buffer.from(bytes, 'utf8').toString('base64')
  }
}

function makeBinding(): {
  binding: HerdrPtyBinding
  push: (frame: HerdrTerminalFrame) => void
  close: () => void
} {
  let frameListener: ((frame: HerdrTerminalFrame) => void) | null = null
  let closedListener: (() => void) | null = null
  const binding = {
    id: 'herdr:test',
    sequenceChars: 0,
    snapshot: '',
    detached: false,
    unsubscribe: [],
    cols: 80,
    rows: 24,
    paneId: 'pane-1',
    sessionName: 'orca',
    incarnationId: 'inc-1',
    cwd: '/tmp',
    identity: {
      projectId: 'p',
      hostId: 'local',
      worktreeId: 'w',
      tabId: 't',
      leafId: 'l',
      version: 2,
      paneId: 'pane-1'
    },
    controller: {
      write: vi.fn(),
      resize: vi.fn(),
      release: vi.fn(),
      onFrame: (cb: (frame: HerdrTerminalFrame) => void) => {
        frameListener = cb
        return () => {
          frameListener = null
        }
      },
      onClosed: (cb: () => void) => {
        closedListener = cb
        return () => {
          closedListener = null
        }
      }
    }
  } as unknown as HerdrPtyBinding

  return {
    binding,
    push: (next) => frameListener?.(next),
    close: () => closedListener?.()
  }
}

describe('waitForFirstHerdrFrame', () => {
  it('emits only the appended tail of subsequent full frames', async () => {
    const { binding, push } = makeBinding()
    const emitData = vi.fn()
    const emitExit = vi.fn()
    const pending = waitForFirstHerdrFrame(binding, { emitData, emitExit, detach: vi.fn() })

    push(frame('line1\n'))
    const first = await pending
    expect(first?.data).toBe('line1\n')
    expect(emitData).not.toHaveBeenCalled()

    push(frame('line1\nline2\n'))
    expect(emitData).toHaveBeenCalledWith({
      id: binding.id,
      data: 'line2\n',
      sequenceChars: 'line2\n'.length
    })

    // A frame whose content changed in place (no shared prefix) replaces the
    // visible screen instead of appending, so the renderer cannot duplicate it.
    push(frame('scrolled\n'))
    expect(emitData).toHaveBeenLastCalledWith({
      id: binding.id,
      data: '\x1b[0m\x1b[2J\x1b[Hscrolled\n',
      sequenceChars: 'line2\n'.length + '\x1b[0m\x1b[2J\x1b[Hscrolled\n'.length
    })
  })

  it('emits the full data of delta frames directly', async () => {
    const { binding, push } = makeBinding()
    const emitData = vi.fn()
    const pending = waitForFirstHerdrFrame(binding, {
      emitData,
      emitExit: vi.fn(),
      detach: vi.fn()
    })

    push(frame('a', { full: true }))
    await pending

    push(frame('b', { full: false, seq: 2 }))
    expect(emitData).toHaveBeenCalledWith({ id: binding.id, data: 'b', sequenceChars: 1 })
  })

  it('emits exit when the controller closes after the first frame', async () => {
    const { binding, push, close } = makeBinding()
    const emitData = vi.fn()
    const emitExit = vi.fn()
    const detach = vi.fn()
    const pending = waitForFirstHerdrFrame(binding, { emitData, emitExit, detach })

    push(frame('prompt'))
    await pending

    close()
    expect(emitExit).toHaveBeenCalledWith({ id: binding.id, code: 0 })
    expect(detach).toHaveBeenCalled()
  })
})
