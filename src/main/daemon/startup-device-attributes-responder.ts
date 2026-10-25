import type { PtyIngressEmission } from '../../shared/pty-startup-ingress'
/** Answer DA1 when ConPTY startup or shell-ready gating prevents a renderer reply; bypass queued stdin. */
import type { Terminal } from '@xterm/headless'

type DeviceAttributesParser = Pick<Terminal['parser'], 'registerCsiHandler'>

const PRIMARY_DEVICE_ATTRIBUTES_QUERIES = ['\x1b[c', '\x1b[0c'] as const

/** Match renderer attributes so startup gating does not change TUI capabilities. */
export const STARTUP_DA1_RESPONSE = '\x1b[?1;2c'

/** Removes startup DA1 queries from renderer-bound output after the daemon answers them. */
export class StartupDeviceAttributesQueryFilter {
  private pending: PtyIngressEmission | null = null
  acceptEmission(span: PtyIngressEmission): PtyIngressEmission[] {
    const output: PtyIngressEmission[] = []
    if (span.transformed) {
      const pending = this.releaseEmission()
      if (pending) {
        output.push(pending)
      }
      output.push(span)
      return output
    }
    const input = this.pending
      ? { ...span, data: this.pending.data + span.data, rawStartSeq: this.pending.rawStartSeq }
      : span
    this.pending = null
    const emit = (start: number, end: number, omitted = false): void => {
      if (end > start) {
        output.push({
          data: omitted ? '' : input.data.slice(start, end),
          rawStartSeq: input.rawStartSeq + start,
          rawEndSeq: input.rawStartSeq + end,
          transformed: omitted
        })
      }
    }
    let offset = 0
    while (offset < input.data.length) {
      const candidate = input.data.indexOf('\x1b', offset)
      if (candidate === -1) {
        emit(offset, input.data.length)
        break
      }
      emit(offset, candidate)
      const query = PRIMARY_DEVICE_ATTRIBUTES_QUERIES.find((value) =>
        input.data.startsWith(value, candidate)
      )
      if (query) {
        emit(candidate, candidate + query.length, true)
        offset = candidate + query.length
        continue
      }
      const tail = input.data.slice(candidate)
      if (PRIMARY_DEVICE_ATTRIBUTES_QUERIES.some((value) => value.startsWith(tail))) {
        this.pending = { ...input, data: tail, rawStartSeq: input.rawStartSeq + candidate }
        break
      }
      emit(candidate, candidate + 1)
      offset = candidate + 1
    }
    return output
  }

  releaseEmission(): PtyIngressEmission | null {
    const pending = this.pending
    this.pending = null
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
