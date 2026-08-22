import { describe, expect, it } from 'vitest'
import { OrcaWindowManager } from './orca-window-manager'

function makeWindow(
  id: number,
  bounds: { x: number; y: number; width: number; height: number },
  options: { destroyed?: boolean; visible?: boolean } = {}
) {
  const webContents = {
    id: id + 100,
    getType: () => 'window',
    isDestroyed: () => options.destroyed === true
  }
  return {
    id,
    webContents,
    getBounds: () => bounds,
    isDestroyed: () => options.destroyed === true,
    isVisible: () => options.visible !== false
  }
}

describe('OrcaWindowManager', () => {
  it('maps every registered Orca renderer without trusting unknown senders', () => {
    const manager = new OrcaWindowManager()
    const control = makeWindow(1, { x: 0, y: 0, width: 800, height: 600 })
    const secondary = makeWindow(2, { x: 800, y: 0, width: 800, height: 600 })

    manager.register(control as never, 'control')
    manager.register(secondary as never, 'secondary')

    expect(manager.getWindowForSender(control.webContents as never)).toBe(control)
    expect(manager.getWindowForSender(secondary.webContents as never)).toBe(secondary)
    expect(manager.isTrustedSender(control.webContents as never)).toBe(true)
    expect(manager.isTrustedSender(secondary.webContents as never)).toBe(true)
    expect(
      manager.isTrustedSender({
        id: 999,
        isDestroyed: () => false,
        getType: () => 'window'
      } as never)
    ).toBe(false)
  })

  it('promotes the most recently focused surviving window', () => {
    const manager = new OrcaWindowManager()
    const first = makeWindow(1, { x: 0, y: 0, width: 800, height: 600 })
    const second = makeWindow(2, { x: 800, y: 0, width: 800, height: 600 })
    const third = makeWindow(3, { x: 1600, y: 0, width: 800, height: 600 })
    manager.register(first as never, 'control')
    manager.register(second as never, 'secondary')
    manager.register(third as never, 'secondary')
    manager.noteFocused(second.id)
    manager.noteFocused(third.id)
    manager.noteFocused(second.id)

    expect(manager.getMostRecentWindow()).toBe(second)

    manager.unregister(first.id)

    expect(manager.promoteControl()).toBe(second)
    expect(manager.getControlWindow()).toBe(second)
    expect(manager.getRole(second.id)).toBe('control')
    expect(manager.getRole(third.id)).toBe('secondary')
  })

  it('uses the lowest window id when no focus order distinguishes candidates', () => {
    const manager = new OrcaWindowManager()
    const later = makeWindow(9, { x: 0, y: 0, width: 800, height: 600 })
    const earlier = makeWindow(4, { x: 800, y: 0, width: 800, height: 600 })
    manager.register(later as never, 'secondary')
    manager.register(earlier as never, 'secondary')

    expect(manager.promoteControl()).toBe(earlier)
  })

  it('resolves a visible target at a DIP point and excludes the source window', () => {
    const manager = new OrcaWindowManager()
    const source = makeWindow(1, { x: 0, y: 0, width: 900, height: 700 })
    const target = makeWindow(2, { x: 900, y: 0, width: 900, height: 700 })
    const hidden = makeWindow(3, { x: 900, y: 0, width: 900, height: 700 }, { visible: false })
    manager.register(source as never, 'control')
    manager.register(target as never, 'secondary')
    manager.register(hidden as never, 'secondary')

    expect(manager.getWindowAtPoint({ x: 950, y: 50 }, source.id)).toBe(target)
    expect(manager.getWindowAtPoint({ x: 50, y: 50 }, source.id)).toBeNull()
    expect(manager.getWindowAtPoint({ x: 4000, y: 50 })).toBeNull()
  })

  it('drops destroyed windows from lookups', () => {
    const manager = new OrcaWindowManager()
    const destroyed = makeWindow(1, { x: 0, y: 0, width: 800, height: 600 }, { destroyed: true })
    manager.register(destroyed as never, 'control')

    expect(manager.getAllWindows()).toEqual([])
    expect(manager.getControlWindow()).toBeNull()
    expect(manager.isTrustedSender(destroyed.webContents as never)).toBe(false)
  })
})
