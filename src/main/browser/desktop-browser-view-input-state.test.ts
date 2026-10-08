import { describe, expect, it, vi } from 'vitest'
import { DesktopBrowserViewInputSchema } from '../../shared/desktop-browser-view-input'
import { DesktopBrowserViewInputState } from './desktop-browser-view-input-state'

const key = (type: 'down' | 'up', code = 'ShiftLeft') =>
  DesktopBrowserViewInputSchema.parse({ kind: 'key', type, key: 'Shift', code })
const mouse = (type: 'down' | 'up' | 'move', x = 0.25, y = 0.5) =>
  DesktopBrowserViewInputSchema.parse({ kind: 'mouse', type, x, y, button: 'left' })

describe('desktop browser forwarded input lifetime', () => {
  it('allows matching releases after input is disabled and ignores repeated cleanup', async () => {
    const send = vi.fn(async () => {})
    const state = new DesktopBrowserViewInputState(send)
    await state.dispatch(mouse('down'), true)
    await state.dispatch(key('down'), true)
    await state.dispatch(mouse('up'), false)
    await state.dispatch(key('up'), false)
    await state.dispatch(mouse('up'), false)
    await state.dispatch(key('up'), false)
    expect(send).toHaveBeenCalledTimes(4)
    await state.releaseAll()
    expect(send).toHaveBeenCalledTimes(4)
  })

  it('rejects new presses, movement, wheel and text while disabled', async () => {
    const send = vi.fn(async () => {})
    const state = new DesktopBrowserViewInputState(send)
    for (const input of [
      mouse('down'),
      mouse('move'),
      key('down'),
      DesktopBrowserViewInputSchema.parse({ kind: 'text', text: 'x' }),
      DesktopBrowserViewInputSchema.parse({ kind: 'composition', text: 'x' }),
      DesktopBrowserViewInputSchema.parse({
        kind: 'mouse',
        type: 'wheel',
        x: 0,
        y: 0,
        deltaX: 0,
        deltaY: 1
      })
    ]) {
      await expect(state.dispatch(input, false)).rejects.toThrow('input is unavailable')
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('releases every held input at its latest pointer position without replaying text', async () => {
    const send = vi.fn(async () => {})
    const state = new DesktopBrowserViewInputState(send)
    await state.dispatch(mouse('down'), true)
    await state.dispatch(mouse('move', 0.8, 0.9), true)
    await state.dispatch(
      DesktopBrowserViewInputSchema.parse({
        kind: 'key',
        type: 'down',
        key: 'a',
        code: 'KeyA',
        text: 'a',
        modifiers: ['Shift']
      }),
      true
    )
    await state.dispatch(key('down'), true)
    send.mockClear()
    await state.releaseAll()
    expect(send.mock.calls).toEqual([
      [{ kind: 'mouse', type: 'up', x: 0.8, y: 0.9, button: 'left', buttons: 0, modifiers: [] }],
      [{ kind: 'key', type: 'up', key: 'a', code: 'KeyA', modifiers: [] }],
      [{ kind: 'key', type: 'up', key: 'Shift', code: 'ShiftLeft', modifiers: [] }]
    ])
    await state.releaseAll()
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('retains an uncertain press and a rejected release until cleanup actually settles', async () => {
    const send = vi.fn(async () => {})
    const state = new DesktopBrowserViewInputState(send)
    send.mockRejectedValueOnce(new Error('unknown dispatch effect'))
    await expect(state.dispatch(key('down'), true)).rejects.toThrow('unknown dispatch effect')
    send.mockRejectedValueOnce(new Error('release failed'))
    await expect(state.releaseAll()).rejects.toThrow('Releasing desktop browser input failed')
    await state.releaseAll()
    expect(send).toHaveBeenCalledTimes(3)
    await state.releaseAll()
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('attempts the remaining releases after one fails and retries only the failure', async () => {
    const send = vi.fn(async () => {})
    const state = new DesktopBrowserViewInputState(send)
    await state.dispatch(mouse('down'), true)
    await state.dispatch(key('down'), true)
    send.mockClear()
    send.mockRejectedValueOnce(new Error('mouse release failed'))
    await expect(state.releaseAll()).rejects.toThrow('Releasing desktop browser input failed')
    expect(send).toHaveBeenCalledTimes(2)
    await state.releaseAll()
    expect(send).toHaveBeenCalledTimes(3)
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'mouse', type: 'up' }))
  })
})
