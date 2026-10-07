import { describe, expect, it, vi } from 'vitest'
import { installPtyResizeEvents } from '../../src/renderer/src/components/terminal-pane/pty-connection/pty-resize-events'

function setup(overrides = {}) {
  const dimensions = { css: { cell: { width: 9.025, height: 18 } } }
  let change = () => {}
  const sourceDispose = vi.fn()
  const terminal = {
    cols: 80,
    rows: 24,
    dimensions,
    onResize: vi.fn(() => ({ dispose: vi.fn() })),
    onDimensionsChange: vi.fn((listener) => {
      change = listener
      return { dispose: sourceDispose }
    })
  }
  const session = {
    pane: { terminal },
    connectionId: null,
    runtimeEnvironmentId: null,
    disposed: false,
    suppressStructuralReplayPtyResize: false,
    suppressViewportClaimTerminalResize: false,
    transport: { isConnected: () => true },
    isRendererPtyResizeAuthoritative: () => true,
    shouldSuppressDesktopPtyResize: () => false,
    forwardPtyResize: vi.fn(),
    ...overrides
  }
  installPtyResizeEvents(session)
  return { session, terminal, sourceDispose, change: () => change(dimensions) }
}

describe('image geometry resize forwarding', () => {
  it.each(['hidden', 'parked', 'disconnected', 'replay', 'viewport-claim'])(
    'keeps a %s font change pending until accepted',
    (reason) => {
      let visible = reason !== 'hidden'
      let parked = reason === 'parked'
      let connected = reason !== 'disconnected'
      const p = setup({
        isRendererPtyResizeAuthoritative: () => visible,
        shouldSuppressDesktopPtyResize: () => parked,
        transport: { isConnected: () => connected },
        suppressStructuralReplayPtyResize: reason === 'replay',
        suppressViewportClaimTerminalResize: reason === 'viewport-claim'
      })
      try {
        p.terminal.dimensions.css.cell.width = 10.975
        p.change()
        expect(p.session.forwardPtyResize).not.toHaveBeenCalled()
        visible = true
        parked = false
        connected = true
        p.session.suppressStructuralReplayPtyResize = false
        p.session.suppressViewportClaimTerminalResize = false
        p.session.imageCellMeasurementsDisposable.reassert()
        expect(p.session.forwardPtyResize).toHaveBeenCalledExactlyOnceWith(80, 24)
        p.session.imageCellMeasurementsDisposable.reassert()
        expect(p.session.forwardPtyResize).toHaveBeenCalledOnce()
      } finally {
        p.session.imageCellMeasurementsDisposable.dispose()
      }
    }
  )

  it.each([{ connectionId: 'ssh-1' }, { runtimeEnvironmentId: 'paired-1' }])(
    'does not install a local calibration observer for %j',
    (owner) => {
      const p = setup(owner)
      expect(p.terminal.onDimensionsChange).not.toHaveBeenCalled()
      expect(p.session.imageCellMeasurementsDisposable).toBeUndefined()
    }
  )

  it('does not publish a late dimension event after disposal', () => {
    const p = setup()
    p.session.disposed = true
    p.terminal.dimensions.css.cell.height = 21
    p.change()
    expect(p.session.forwardPtyResize).not.toHaveBeenCalled()
    p.session.imageCellMeasurementsDisposable.dispose()
    expect(p.sourceDispose).toHaveBeenCalledOnce()
  })
})
