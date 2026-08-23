import { describe, expect, it, vi } from 'vitest'
import { bindControlWindowHandoff } from './control-window-handoff'
import { OrcaWindowManager } from './orca-window-manager'

type ClosedListener = () => void

function makeWindow(id: number) {
  const closedListeners: ClosedListener[] = []
  const window = {
    id,
    webContents: {
      id: id + 100,
      getType: () => 'window',
      isDestroyed: () => false
    },
    isDestroyed: () => false,
    on: (event: string, listener: ClosedListener) => {
      if (event === 'closed') {
        closedListeners.push(listener)
      }
      return window
    }
  }
  return {
    window,
    close: () => closedListeners.forEach((listener) => listener())
  }
}

function wireRemoval(manager: OrcaWindowManager, target: ReturnType<typeof makeWindow>): void {
  target.window.on('closed', () => manager.remove(target.window.id))
}

describe('control window handoff', () => {
  it('settles transfers before moving runtime authority and binding the promoted control', async () => {
    const manager = new OrcaWindowManager()
    const control = makeWindow(1)
    const candidate = makeWindow(2)
    manager.register(control.window as never, 'control')
    manager.register(candidate.window as never, 'secondary')
    wireRemoval(manager, control)
    const calls: string[] = []
    let settle!: () => void
    const transfersSettled = new Promise<void>((resolve) => {
      settle = resolve
    })
    bindControlWindowHandoff(control.window as never, {
      windows: manager,
      isCurrentControl: () => true,
      getIsQuitting: () => false,
      onWindowClosed: vi.fn(),
      fenceAndSettleTransfers: () => {
        calls.push('fence-transfers')
        return transfersSettled
      },
      markGraphUnavailable: () => calls.push('graph-unavailable:1'),
      attachRuntimeWindow: (window) => calls.push(`runtime-attached:${window.id}`),
      onHandoff: (window) => calls.push(`services-attached:${window.id}`),
      releaseTransferFence: () => calls.push('release-transfers'),
      onVacated: () => calls.push('vacated')
    })

    control.close()
    await Promise.resolve()
    expect(calls).toEqual(['fence-transfers'])

    settle()
    await vi.waitFor(() => expect(calls).toContain('release-transfers'))
    expect(calls).toEqual([
      'fence-transfers',
      'graph-unavailable:1',
      'runtime-attached:2',
      'services-attached:2',
      'release-transfers'
    ])
  })

  it('defers election until close handoff claims the active token', () => {
    const manager = new OrcaWindowManager()
    const control = makeWindow(1)
    const older = makeWindow(2)
    const recent = makeWindow(3)
    manager.register(control.window as never, 'control')
    manager.register(older.window as never, 'secondary')
    manager.register(recent.window as never, 'secondary')
    manager.noteFocused(recent.window.id)
    wireRemoval(manager, control)
    control.window.on('closed', () => expect(manager.getControlWindow()).toBeNull())
    const onHandoff = vi.fn()
    const onVacated = vi.fn()
    bindControlWindowHandoff(control.window as never, {
      windows: manager,
      isCurrentControl: () => true,
      getIsQuitting: () => false,
      onWindowClosed: vi.fn(),
      onHandoff,
      onVacated
    })

    control.close()

    expect(manager.getControlWindow()).toBe(recent.window)
    expect(onHandoff).toHaveBeenCalledOnce()
    expect(onHandoff).toHaveBeenCalledWith(recent.window)
    expect(onVacated).not.toHaveBeenCalled()
  })

  it('does not hand off or vacate from a stale transition', () => {
    const manager = new OrcaWindowManager()
    const control = makeWindow(1)
    const candidate = makeWindow(2)
    manager.register(control.window as never, 'control')
    manager.register(candidate.window as never, 'secondary')
    wireRemoval(manager, control)
    const onHandoff = vi.fn()
    const onVacated = vi.fn()
    bindControlWindowHandoff(control.window as never, {
      windows: manager,
      isCurrentControl: () => true,
      getIsQuitting: () => false,
      onWindowClosed: vi.fn(),
      onHandoff,
      onVacated
    })
    expect(manager.beginControlTransition(control.window.id)).not.toBeNull()

    control.close()

    expect(manager.getControlWindow()).toBeNull()
    expect(onHandoff).not.toHaveBeenCalled()
    expect(onVacated).not.toHaveBeenCalled()
  })

  it.each([
    ['quit', true, true],
    ['no candidate', false, false]
  ])('does not hand off on %s', (_label, quitting, includeCandidate) => {
    const manager = new OrcaWindowManager()
    const control = makeWindow(1)
    manager.register(control.window as never, 'control')
    if (includeCandidate) {
      manager.register(makeWindow(2).window as never, 'secondary')
    }
    wireRemoval(manager, control)
    const onHandoff = vi.fn()
    const onVacated = vi.fn()
    bindControlWindowHandoff(control.window as never, {
      windows: manager,
      isCurrentControl: () => true,
      getIsQuitting: () => quitting,
      onWindowClosed: vi.fn(),
      onHandoff,
      onVacated
    })

    control.close()

    expect(manager.getControlWindow()).toBeNull()
    expect(onHandoff).not.toHaveBeenCalled()
    expect(onVacated).toHaveBeenCalledOnce()
  })

  it('keeps terminal transfers fenced when no control can be promoted', async () => {
    const manager = new OrcaWindowManager()
    const control = makeWindow(1)
    manager.register(control.window as never, 'control')
    wireRemoval(manager, control)
    const releaseTransferFence = vi.fn()
    bindControlWindowHandoff(control.window as never, {
      windows: manager,
      isCurrentControl: () => true,
      getIsQuitting: () => false,
      onWindowClosed: vi.fn(),
      fenceAndSettleTransfers: () => Promise.resolve(),
      releaseTransferFence,
      onHandoff: vi.fn(),
      onVacated: vi.fn()
    })

    control.close()
    await Promise.resolve()
    await Promise.resolve()

    expect(releaseTransferFence).not.toHaveBeenCalled()
  })

  it('vacates a failed promotion and keeps the replacement graph unavailable', async () => {
    const manager = new OrcaWindowManager()
    const control = makeWindow(1)
    const candidate = makeWindow(2)
    manager.register(control.window as never, 'control')
    manager.register(candidate.window as never, 'secondary')
    wireRemoval(manager, control)
    const markGraphUnavailable = vi.fn()
    const onVacated = vi.fn()
    const releaseTransferFence = vi.fn()
    bindControlWindowHandoff(control.window as never, {
      windows: manager,
      isCurrentControl: () => true,
      getIsQuitting: () => false,
      onWindowClosed: vi.fn(),
      fenceAndSettleTransfers: () => Promise.resolve(),
      markGraphUnavailable,
      attachRuntimeWindow: vi.fn(),
      releaseTransferFence,
      onHandoff: () => {
        throw new Error('promotion failed')
      },
      onVacated
    })

    control.close()
    await Promise.resolve()
    await Promise.resolve()

    expect(markGraphUnavailable).toHaveBeenCalledTimes(2)
    expect(onVacated).toHaveBeenCalledOnce()
    expect(releaseTransferFence).not.toHaveBeenCalled()
  })

  it('vacates when runtime authority cannot attach to the promotion', async () => {
    const manager = new OrcaWindowManager()
    const control = makeWindow(1)
    const candidate = makeWindow(2)
    manager.register(control.window as never, 'control')
    manager.register(candidate.window as never, 'secondary')
    wireRemoval(manager, control)
    const onVacated = vi.fn()
    bindControlWindowHandoff(control.window as never, {
      windows: manager,
      isCurrentControl: () => true,
      getIsQuitting: () => false,
      onWindowClosed: vi.fn(),
      fenceAndSettleTransfers: () => Promise.resolve(),
      markGraphUnavailable: vi.fn(),
      attachRuntimeWindow: () => {
        throw new Error('runtime attach failed')
      },
      onHandoff: vi.fn(),
      onVacated
    })

    control.close()
    await Promise.resolve()
    await Promise.resolve()

    expect(onVacated).toHaveBeenCalledOnce()
  })
})
