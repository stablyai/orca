/** Answer DA1 (and the cursor-position query pwsh's console blocks on, #27293) when ConPTY startup or shell-ready gating prevents a renderer reply; bypass queued stdin. */
import type { Terminal } from '@xterm/headless'
import { PRIMARY_DEVICE_ATTRIBUTES_QUERY_SEQUENCES } from '../../shared/terminal-reply-query-extraction'

type DeviceAttributesParser = Pick<Terminal['parser'], 'registerCsiHandler'>



/** Match renderer attributes so startup gating does not change TUI capabilities. */
export const STARTUP_DA1_RESPONSE = '\x1b[?1;2c'

/** Why row 1, column 1: the report only has to unblock the shell's startup read
 *  (it re-renders once PSReadLine owns the console), and the renderer's own
 *  answer would arrive queued anyway. Matches the value the live zsh/fish suites
 *  reply for fish's identical startup query. */
export const STARTUP_CURSOR_POSITION_RESPONSE = '\x1b[1;1R'

/** Startup queries the daemon answers on the child's behalf while the shell-ready
 *  barrier owns input authority. Derives from the shared DA1 list so upstream
 *  additions keep flowing in; the cursor-position query pwsh blocks on (#27293)
 *  rides alongside. Kept in one list so the split-chunk carry logic covers every
 *  entry. */
const STARTUP_QUERY_STRINGS = [...PRIMARY_DEVICE_ATTRIBUTES_QUERY_SEQUENCES, '\x1b[6n'] as const

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

/** Release the startup handler so the renderer resumes DA1 authority. */
export function installDeviceAttributesResponder(deps: {
  parser: DeviceAttributesParser
  response: string
  reply: (data: string) => void
}): () => void {
  const handler = deps.parser.registerCsiHandler({ final: 'c' }, (params) => {
    // Secondary and tertiary queries use prefixes; unsupported primary parameters must fall through.
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
