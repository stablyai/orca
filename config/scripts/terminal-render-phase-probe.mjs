/* eslint-disable no-control-regex -- Terminal control-sequence metadata, never input text. */
export function installTerminalRenderPhaseProbe() {
  if (window.__orcaRenderPhaseProbe || !window.__orcaLiveRenderPanes) {
    throw new Error('Missing verified pane references, or another probe is active')
  }
  const events = []
  const cleanup = []
  let dropped = 0
  const startedAt = performance.now()
  function record(pane, kind, extra = {}) {
    if (!pane.terminal.element?.contains(document.activeElement)) {
      return
    }
    const core = pane.terminal._core
    if (events.length >= 5000) {
      dropped++
      return
    }
    events.push({
      at: performance.now(),
      leafId: pane.leafId,
      kind,
      paused: core?._renderService?._isPaused,
      sync: core?.coreService?.decPrivateModes?.synchronizedOutput,
      ...extra
    })
  }
  function wrap(object, key, makeWrapper) {
    const original = object?.[key]
    if (typeof original !== 'function') {
      return
    }
    const wrapped = makeWrapper(original)
    object[key] = wrapped
    cleanup.push(() => {
      if (object[key] === wrapped) {
        object[key] = original
      }
    })
  }
  function subscribe(object, key, listener) {
    const disposable = object?.[key]?.(listener)
    if (disposable) {
      cleanup.push(() => disposable.dispose())
    }
  }
  for (const pane of window.__orcaLiveRenderPanes) {
    const terminal = pane.terminal
    const service = terminal?._core?._renderService
    if (!service) {
      continue
    }
    subscribe(terminal, 'onData', (data) => record(pane, 'dispatch', { bytes: data.length }))
    subscribe(terminal, 'onWriteParsed', () => record(pane, 'parsed'))
    subscribe(terminal, 'onRender', () => record(pane, 'public-render'))
    subscribe(service, 'onRender', () => record(pane, 'service-render'))
    wrap(
      terminal,
      'write',
      (original) =>
        function (data, ...args) {
          if (terminal.element?.contains(document.activeElement)) {
            const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
            const controls = [...text.matchAll(/\x1b\[([0-?]*)([ -/]*)([@-~])/g)]
            const withoutControls = text
              .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
              .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
              .replace(/\x1b[()][0-~]/g, '')
              .replace(/[\x00-\x1f\x7f]/g, '')
            record(pane, 'write', {
              bytes: data.length,
              printableChars: withoutControls.length,
              syncStarts: controls.filter((c) => c[1] === '?2026' && c[3] === 'h').length,
              syncEnds: controls.filter((c) => c[1] === '?2026' && c[3] === 'l').length,
              csiFinals: controls.map((c) => c[3]).join('')
            })
          }
          return original.call(this, data, ...args)
        }
    )
    wrap(
      service,
      'refreshRows',
      (original) =>
        function (start, end, sync, redrawOnly) {
          record(pane, 'refresh-request', {
            start,
            end,
            synchronous: !!sync,
            redrawOnly: !!redrawOnly
          })
          return original.call(this, start, end, sync, redrawOnly)
        }
    )
    const renderer = service._renderer?.value ?? service._renderer
    wrap(
      renderer,
      'renderRows',
      (original) =>
        function (...args) {
          const before = performance.now()
          const result = original.apply(this, args)
          record(pane, 'render-rows', { duration: performance.now() - before })
          return result
        }
    )
  }
  const keydown = (event) => {
    const pane = window.__orcaLiveRenderPanes.find((p) =>
      p.terminal.element?.contains(event.target)
    )
    if (pane) {
      record(pane, 'keydown', { eventAt: event.timeStamp, trusted: event.isTrusted })
    }
  }
  document.addEventListener('keydown', keydown, true)
  cleanup.push(() => document.removeEventListener('keydown', keydown, true))
  window.__orcaRenderPhaseProbe = {
    stop() {
      for (const dispose of cleanup.toReversed()) {
        dispose()
      }
      delete window.__orcaRenderPhaseProbe
      delete window.__orcaLiveRenderPanes
      return { startedAt, endedAt: performance.now(), events, dropped }
    }
  }
  return { startedAt, panes: window.__orcaLiveRenderPanes.length }
}
