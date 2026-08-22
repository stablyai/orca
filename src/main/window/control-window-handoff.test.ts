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
})
