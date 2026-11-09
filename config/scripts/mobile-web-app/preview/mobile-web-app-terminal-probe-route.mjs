// Keep terminal probe route in scratch: committing under mobile/app would register test-only route shell could open.

export const COLS = 80
export const ROWS = 24
// Sample must reach host chunker’s measured 48KiB size.
export const MIN_STREAM_BYTES = 48 * 1024
// Repeat run marker at both edges so readback proves entire stream reached buffer.
export const FIRST_MARKER = 'ORCA-TERMINAL-RENDER-FIRST'
export const LAST_MARKER = 'ORCA-TERMINAL-RENDER-LAST'

// Generate grid-dependent escape-dense 48KiB+ sample; sizing solely from cap under test would be circular.
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

// Expose actual component handle/notifies in scratch route.
export function probeRouteSource(componentPath) {
  return `import { useCallback, useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { TerminalWebView } from ${JSON.stringify(componentPath)}

export default function TerminalProbeRoute() {
  const handleRef = useRef(null)
  // The terminal frame as React Native laid it out, which is what the session fits.
  const frameRef = useRef({ width: 0, height: 0 })
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
    globalThis.__orcaTerminalProbe = {
      init: (cols, rows, initialData) =>
        handleRef.current?.init({ cols, rows, initialData, oscLinks: [], frame: frameRef.current }),
      write: (data) => handleRef.current?.write(data),
      selectAll: () => handleRef.current?.doSelectAll(),
      awaitReady: () => handleRef.current?.awaitReady(),
      setMounted: (next) => setMounted(next)
    }
  }, [])
  return (
    <View testID="terminal-probe" style={{ flex: 1 }}>
      <View
        style={{ flex: 1 }}
        onLayout={(event) => {
          frameRef.current = event.nativeEvent.layout
        }}
      >
        {mounted ? (
          <TerminalWebView
            ref={handleRef}
            onWebReady={onWebReady}
            onEngineError={onEngineError}
            onSelectionCopy={onSelectionCopy}
          />
        ) : null}
      </View>
    </View>
  )
}
`
}

export const LAYOUT_SOURCE = `import { Slot } from 'expo-router'
export default function ProbeLayout() {
  return <Slot />
}
`
