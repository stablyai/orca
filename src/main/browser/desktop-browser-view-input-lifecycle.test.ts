import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopBrowserViewInputSchema } from '../../shared/desktop-browser-view-input'
import { createDesktopBrowserViewServiceFixture } from './desktop-browser-view-service-test-fixture'

const send = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('./desktop-browser-view-input', () => ({ dispatchDesktopBrowserViewInput: send }))

describe('desktop browser service input cleanup', () => {
  beforeEach(() => send.mockReset())

  it('automatically releases forwarded keys when a modal disables input and rejects new text', async () => {
    const fixture = createDesktopBrowserViewServiceFixture()
    const state = await fixture.service.create(fixture.sender, fixture.args)
    const layout = {
      ...state,
      bounds: { x: 0, y: 0, width: 600, height: 500 },
      visible: false,
      inputLocked: false,
      forwardInput: true
    }
    await fixture.service.updateLayout(fixture.sender, layout)
    await fixture.service.input(fixture.sender, {
      ...state,
      input: DesktopBrowserViewInputSchema.parse({
        kind: 'key',
        type: 'down',
        key: 'Shift',
        code: 'ShiftLeft',
        modifiers: ['Shift']
      })
    })
    await fixture.service.updateLayout(fixture.sender, { ...layout, forwardInput: false })
    expect(send).toHaveBeenLastCalledWith(fixture.native.view.webContents, {
      kind: 'key',
      type: 'up',
      key: 'Shift',
      code: 'ShiftLeft',
      modifiers: []
    })
    await fixture.service.input(fixture.sender, {
      ...state,
      input: DesktopBrowserViewInputSchema.parse({
        kind: 'key',
        type: 'up',
        key: 'Shift',
        code: 'ShiftLeft'
      })
    })
    expect(send).toHaveBeenCalledTimes(2)
    await expect(
      fixture.service.input(fixture.sender, {
        ...state,
        input: DesktopBrowserViewInputSchema.parse({ kind: 'text', text: 'blocked' })
      })
    ).rejects.toThrow('input is unavailable')
    await fixture.service.close(fixture.sender, state)
  })

  it('retains identity fencing even for cleanup releases', async () => {
    const fixture = createDesktopBrowserViewServiceFixture()
    const state = await fixture.service.create(fixture.sender, fixture.args)
    const input = DesktopBrowserViewInputSchema.parse({
      kind: 'key',
      type: 'up',
      key: 'Shift',
      code: 'ShiftLeft'
    })
    await expect(
      fixture.service.input(fixture.sender, {
        ...state,
        generation: 'old-page-generation',
        input
      })
    ).rejects.toThrow('identity')
    expect(send).not.toHaveBeenCalled()
    await fixture.service.close(fixture.sender, state)
  })
})
