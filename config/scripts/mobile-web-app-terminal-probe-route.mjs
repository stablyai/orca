/**
 * The scratch route tree the terminal render check bundles, and the streams it drives.
 *
 * No route serves this screen until C7.7, so the component is reached through a route tree
 * written to a temporary directory. That is a bundler entry and a page under test, not an
 * assertion, and it is here so the check itself stays the list of things being measured. This
 * step retires the moment the session route is registered.
 */

export const COLS = 80
export const ROWS = 24
/** Design §2 measured the host's own chunker at 48 KiB, so the sample is at least one full one. */
export const MIN_STREAM_BYTES = 48 * 1024
/** Printed at the top of the stream and again at the end, so the read-back covers both edges. */
export const FIRST_MARKER = 'ORCA-TERMINAL-RENDER-FIRST'
export const LAST_MARKER = 'ORCA-TERMINAL-RENDER-LAST'

/**
 * An escape-dense sample of at least 48 KiB: an SGR colour change every cell, an erase-to-end and
 * an absolute cursor position per row. Built here rather than committed because it is a function
 * of the grid, and a fixture sized from the constant it is meant to exercise proves nothing.
 */
export function escapeDenseStream() {
  const esc = '\u001b'
  const rows = []
  rows.push(`${esc}[2J${esc}[H${FIRST_MARKER}\r\n`)
  let row = 2
  let bytes = rows[0].length
  while (bytes < MIN_STREAM_BYTES) {
    const cells = []
    for (let column = 0; column < COLS - 1; column++) {
      const colour = 31 + ((row + column) % 7)
      cells.push(`${esc}[${String(colour)};1m${String.fromCharCode(97 + ((row + column) % 26))}`)
    }
    const line = `${esc}[${String(row)};1H${esc}[K${cells.join('')}${esc}[0m\r\n`
    rows.push(line)
    bytes += line.length
    row += 1
  }
  rows.push(`${LAST_MARKER}\r\n`)
  return rows.join('')
}

/**
 * The scratch route: the component under test, its handle and its notifies on `globalThis`.
 *
 * Written rather than committed because it is the bundler's entry and nothing else — a file under
 * `mobile/app` would register a route the shell could open. `beforeinput` is recorded off the
 * xterm helper textarea, which is design §8's cheap half of the IME question: it says what the
 * browser reports for text entering a terminal on the page, and leaves a composing IME on a real
 * keyboard to the device step it cannot answer.
 */
export function probeRouteSource(componentPath) {
  return `import { useCallback, useEffect, useRef, useState } from 'react'
import { TextInput, View } from 'react-native'
import { TerminalWebView } from ${JSON.stringify(componentPath)}

export default function TerminalProbeRoute() {
  const handleRef = useRef(null)
  const [mounted, setMounted] = useState(true)
  const onSelectionCopy = useCallback((text) => {
    globalThis.__orcaTerminalCopied = text
  }, [])
  const onWebReady = useCallback(() => {
    globalThis.__orcaTerminalReady = true
  }, [])
  const onEngineError = useCallback((message) => {
    globalThis.__orcaTerminalEngineErrors.push(message)
  }, [])
  useEffect(() => {
    globalThis.__orcaTerminalEngineErrors = globalThis.__orcaTerminalEngineErrors ?? []
    globalThis.__orcaTerminalBeforeInput = []
    globalThis.__orcaTerminalProbe = {
      init: (cols, rows, data) => handleRef.current?.init(cols, rows, data, false, []),
      write: (data) => handleRef.current?.write(data),
      selectAll: () => handleRef.current?.doSelectAll(),
      measure: () => handleRef.current?.measureFitDimensions(),
      awaitReady: () => handleRef.current?.awaitReady(),
      setMounted: (next) => setMounted(next)
    }
    const onBeforeInput = (event) => {
      globalThis.__orcaTerminalBeforeInput.push({
        inputType: event.inputType,
        data: event.data === null ? null : String(event.data),
        isComposing: !!event.isComposing
      })
    }
    document.addEventListener('beforeinput', onBeforeInput, true)
    return () => document.removeEventListener('beforeinput', onBeforeInput, true)
  }, [])
  return (
    <View testID="terminal-probe" style={{ flex: 1 }}>
      {mounted ? (
        <TerminalWebView
          ref={handleRef}
          onWebReady={onWebReady}
          onEngineError={onEngineError}
          onSelectionCopy={onSelectionCopy}
        />
      ) : null}
      {/* The shape the terminal's live input takes on the page: xterm's own textarea is inert by
          the document's design, so this is where typed text arrives. */}
      <TextInput testID="terminal-live-input" style={{ fontSize: 16 }} />
    </View>
  )
}
`
}

/**
 * The same page with no terminal on it.
 *
 * The page entry already carries Zod, which probes for `new Function` and swallows the
 * `EvalError`, so the shell's `script-src 'self'` records one refusal on any route before a line
 * of terminal code runs. Comparing against this control is what makes "zero violations" a
 * statement about the terminal rather than about the bundle it lives in.
 */
export const CONTROL_SOURCE = `import { View } from 'react-native'

export default function ControlRoute() {
  globalThis.__orcaTerminalControlMounted = true
  return <View testID="terminal-control" />
}
`

export const LAYOUT_SOURCE = `import { Slot } from 'expo-router'
export default function ProbeLayout() {
  return <Slot />
}
`
