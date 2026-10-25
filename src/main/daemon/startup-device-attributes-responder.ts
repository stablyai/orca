/** Answer DA1 when ConPTY startup or shell-ready gating prevents a renderer reply; bypass queued stdin. */
import type { Terminal } from '@xterm/headless'

type DeviceAttributesParser = Pick<Terminal['parser'], 'registerCsiHandler'>

const PRIMARY_DEVICE_ATTRIBUTES_QUERIES = ['\x1b[c', '\x1b[0c'] as const

/** Match renderer attributes so startup gating does not change TUI capabilities. */
export const STARTUP_DA1_RESPONSE = '\x1b[?1;2c'

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
      const query = PRIMARY_DEVICE_ATTRIBUTES_QUERIES.find((value) =>
        input.startsWith(value, candidate)
      )
      if (query) {
        offset = candidate + query.length
        continue
      }
      const tail = input.slice(candidate)
      if (PRIMARY_DEVICE_ATTRIBUTES_QUERIES.some((value) => value.startsWith(tail))) {
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
