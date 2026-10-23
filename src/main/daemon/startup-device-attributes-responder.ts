/**
 * Primary Device Attributes (DA1) responders for the daemon's headless emulator.
 *
 * Both callers answer startup capability queries (DA1, and the cursor position
 * report pwsh's .NET console blocks on) on behalf of a renderer that cannot
 * answer past the queue, and consume the query so the renderer's xterm never
 * sees it and cannot double-reply:
 *
 * - ConPTY 1.22+ blocks at spawn awaiting a DA1 reply.
 * - The shell-ready barrier queues all inbound input until the ready marker,
 *   including the renderer's DA1 reply — and a shell that withholds its first
 *   prompt until a startup query is answered (fish waits 10s on DA1; pwsh blocks
 *   on the cursor position report while reading stdin, consuming queued input as
 *   the reply) never emits the marker that would release it. That caller's
 *   `reply` must write straight to the subprocess, past the queue, or the
 *   deadlock remains.
 */
import type { Terminal } from '@xterm/headless'

type DeviceAttributesParser = Pick<Terminal['parser'], 'registerCsiHandler'>



/** Matches what the renderer's xterm answers for xterm-* TERMs, so consuming the
 *  query upstream cannot change the capabilities a TUI sees. */
export const STARTUP_DA1_RESPONSE = '\x1b[?1;2c'

/** Why row 1, column 1: the report only has to unblock the shell's startup read
 *  (it re-renders once PSReadLine owns the console), and the renderer's own
 *  answer would arrive queued anyway. Matches the value the live zsh/fish suites
 *  reply for fish's identical startup query. */
export const STARTUP_CURSOR_POSITION_RESPONSE = '\x1b[1;1R'

/** Startup queries the daemon answers on the child's behalf while the shell-ready
 *  barrier owns input authority. Kept in one list so the split-chunk carry logic
 *  covers every entry. */
const STARTUP_QUERY_STRINGS = ['\x1b[c', '\x1b[0c', '\x1b[6n'] as const

/** Removes startup DA1 queries from renderer-bound output after the daemon answers them. */
export class StartupDeviceAttributesQueryFilter {
  private pending = ''

  accept(data: string): string {
    const input = this.pending + data
    this.pending = ''
    let output = ''
    let offset = 0

    while (offset < input.length) {
      const candidate = input.indexOf('\x1b', offset)
      if (candidate === -1) {
        output += input.slice(offset)
        break
      }
      output += input.slice(offset, candidate)
      const query = STARTUP_QUERY_STRINGS.find((value) =>
        input.startsWith(value, candidate)
      )
      if (query) {
        offset = candidate + query.length
        continue
      }
      const tail = input.slice(candidate)
      if (STARTUP_QUERY_STRINGS.some((value) => value.startsWith(tail))) {
        this.pending = tail
        break
      }
      output += '\x1b'
      offset = candidate + 1
    }

    return output
  }

  release(): string {
    const pending = this.pending
    this.pending = ''
    return pending
  }
}

/** Returns a disposer so a caller scoped to startup can hand DA1 back to the
 *  renderer once its window closes. */
export function installDeviceAttributesResponder(deps: {
  parser: DeviceAttributesParser
  response: string
  reply: (data: string) => void
}): () => void {
  const handler = deps.parser.registerCsiHandler({ final: 'c' }, (params) => {
    // Why the param check: only DA1 is answered here. Secondary/tertiary variants
    // carry a prefix and must fall through to the renderer.
    const isPrimaryQuery = params.length === 0 || (params.length === 1 && params[0] === 0)
    if (!isPrimaryQuery) {
      return false
    }
    deps.reply(deps.response)
    return true
  })
  return () => handler.dispose()
}

/** Returns a disposer so a caller scoped to startup can hand the cursor position
 *  report back to the renderer once its window closes. */
export function installCursorPositionResponder(deps: {
  parser: DeviceAttributesParser
  reply: (data: string) => void
}): () => void {
  const handler = deps.parser.registerCsiHandler({ final: 'n' }, (params) => {
    // Why the param check: only `CSI 6 n` is answered here. DEC-prefixed and
    // other DSR forms must fall through to the renderer.
    const isCursorPositionQuery = params.length === 1 && params[0] === 6
    if (!isCursorPositionQuery) {
      return false
    }
    deps.reply(STARTUP_CURSOR_POSITION_RESPONSE)
    return true
  })
  return () => handler.dispose()
}
