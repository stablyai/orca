import { describe, expect, it } from 'vitest'
import { XTERM_WEBVIEW_SOURCE } from './terminal-webview-html'
import { TERMINAL_QUERY_REPLY_JS } from './terminal-webview-query-reply-injected'

type QueryReplyGate = {
  forward: (data: string) => void
  queueBoundary: (generation: number) => void
  reset: () => void
  resume: () => void
  setGeneration: (generation: number) => void
}

function createQueryReplyGate(notify: (message: unknown) => void): {
  gate: QueryReplyGate
  queuedBoundaries: Array<() => void>
} {
  const queuedBoundaries: Array<() => void> = []
  const factory = new Function(
    'notify',
    'enqueueWriteBoundary',
    `var terminalGeneration = 0;
      ${TERMINAL_QUERY_REPLY_JS}
      return {
        forward: forwardTerminalDataReply,
        queueBoundary: enqueueTerminalDataReplyBoundary,
        reset: resetTerminalDataReplyAuthority,
        resume: resumeTerminalDataReplyAuthority,
        setGeneration: function(next) { terminalGeneration = next; }
      };`
  ) as (
    notify: (message: unknown) => void,
    enqueueBoundary: (callback: () => void) => void
  ) => QueryReplyGate
  const gate = factory(notify, (callback) => queuedBoundaries.push(callback))
  return { gate, queuedBoundaries }
}

describe('mobile terminal query replies', () => {
  it('forwards xterm-generated data only after initial replay drains', () => {
    const listenerIndex = XTERM_WEBVIEW_SOURCE.html.indexOf('term.onData(function(data)')
    const enableIndex = XTERM_WEBVIEW_SOURCE.html.indexOf(
      'attachTerminalQueryReplyBridge(term, gen)',
      listenerIndex
    )
    const notifyIndex = XTERM_WEBVIEW_SOURCE.html.indexOf(
      'forwardTerminalDataReply(data)',
      listenerIndex
    )

    expect(listenerIndex).toBeGreaterThan(-1)
    expect(enableIndex).toBeGreaterThan(listenerIndex)
    expect(notifyIndex).toBeGreaterThan(listenerIndex)
    expect(XTERM_WEBVIEW_SOURCE.html).toContain('disableStdin: false')
    expect(XTERM_WEBVIEW_SOURCE.html).toContain(
      'term.attachCustomKeyEventHandler(function() { return false; })'
    )
    expect(XTERM_WEBVIEW_SOURCE.html).toContain('term.textarea.readOnly = true')
  })

  it('mutes a replacement terminal until its own replay drains', () => {
    const initIndex = XTERM_WEBVIEW_SOURCE.html.indexOf('function init(cols, rows, initialData')
    const disableIndex = XTERM_WEBVIEW_SOURCE.html.indexOf(
      'resetTerminalDataReplyAuthority()',
      initIndex
    )
    const enableIndex = XTERM_WEBVIEW_SOURCE.html.indexOf(
      'attachTerminalQueryReplyBridge(term, gen)',
      disableIndex
    )

    expect(initIndex).toBeGreaterThan(-1)
    expect(disableIndex).toBeGreaterThan(initIndex)
    expect(enableIndex).toBeGreaterThan(disableIndex)
  })

  it('suppresses replay, then forwards live queries queued behind its boundary', () => {
    const messages: unknown[] = []
    const { gate, queuedBoundaries } = createQueryReplyGate((message) => messages.push(message))
    gate.setGeneration(1)
    gate.reset()
    gate.queueBoundary(1)

    gate.forward('\x1b[1;1R')
    expect(messages).toEqual([])

    queuedBoundaries[0]?.()
    gate.forward('\x1b[2;2R')
    expect(messages).toEqual([{ type: 'terminal-data', bytes: '\x1b[2;2R' }])
  })

  it('does not let a superseded generation reclaim reply authority', () => {
    const messages: unknown[] = []
    const { gate, queuedBoundaries } = createQueryReplyGate((message) => messages.push(message))
    gate.setGeneration(1)
    gate.queueBoundary(1)
    gate.setGeneration(2)
    gate.reset()

    queuedBoundaries[0]?.()
    gate.forward('\x1b[1;1R')
    expect(messages).toEqual([])
  })

  it('restores reply authority when clear discards the replay boundary', () => {
    const messages: unknown[] = []
    const { gate, queuedBoundaries } = createQueryReplyGate((message) => messages.push(message))
    gate.setGeneration(1)
    gate.reset()
    gate.queueBoundary(1)

    // A clear drops all queued writes, including the replay boundary.
    queuedBoundaries.length = 0
    gate.resume()
    gate.forward('\x1b[3;4R')

    expect(messages).toEqual([{ type: 'terminal-data', bytes: '\x1b[3;4R' }])
    const clearStart = XTERM_WEBVIEW_SOURCE.html.indexOf("} else if (msg.type === 'clear') {")
    const clearEnd = XTERM_WEBVIEW_SOURCE.html.indexOf(
      "} else if (msg.type === 'measure')",
      clearStart
    )
    expect(XTERM_WEBVIEW_SOURCE.html.slice(clearStart, clearEnd)).toContain(
      'resumeTerminalDataReplyAuthority()'
    )
  })
})
