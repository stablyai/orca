import { recognizeAgentProcessFromCommandLine } from '../shared/agent-process-recognition'
import type { TuiAgent } from '../shared/tui-agent'
import { SHELL_COMMAND_MAX_CHARS } from './shell-command-marker-template'

const COMMAND_MARKER_PREFIX = '\x1b]777;orca-cmd;'
const MAX_NONCE_CHARS = 128
// Why *4: the shells truncate in characters, not bytes, so a 4096-character
// command can be 16384 UTF-8 bytes before base64 widens it again.
const MAX_ENCODED_CHARS = Math.ceil((SHELL_COMMAND_MAX_CHARS * 4 * 4) / 3) + 8
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export type ShellCommandStartedEvent = {
  agent: TuiAgent | null
  trusted: boolean
}

export type ShellCommandMarkerScannerItem =
  | { kind: 'data'; data: string }
  | { kind: 'command-started'; event: ShellCommandStartedEvent; rawLength: number }

function decodeCommand(value: string): string | null {
  if (value.length > MAX_ENCODED_CHARS || !BASE64.test(value)) {
    return null
  }
  try {
    const bytes = Buffer.from(value, 'base64')
    const command = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return command.length <= SHELL_COMMAND_MAX_CHARS ? command : null
  } catch {
    return null
  }
}

function appendData(items: ShellCommandMarkerScannerItem[], data: string): void {
  if (!data) {
    return
  }
  const last = items.at(-1)
  if (last?.kind === 'data') {
    last.data += data
  } else {
    items.push({ kind: 'data', data })
  }
}

export class ShellCommandMarkerScanner {
  private held = ''

  constructor(private readonly expectedNonce: string | null) {}

  accept(data: string): ShellCommandMarkerScannerItem[] {
    let input = this.held + data
    this.held = ''
    const items: ShellCommandMarkerScannerItem[] = []
    while (input) {
      const start = input.indexOf(COMMAND_MARKER_PREFIX[0] as string)
      if (start === -1) {
        appendData(items, input)
        break
      }
      appendData(items, input.slice(0, start))
      const candidate = input.slice(start)
      if (COMMAND_MARKER_PREFIX.startsWith(candidate)) {
        this.held = candidate
        break
      }
      if (!candidate.startsWith(COMMAND_MARKER_PREFIX)) {
        appendData(items, candidate[0] as string)
        input = candidate.slice(1)
        continue
      }
      const bel = candidate.indexOf('\x07', COMMAND_MARKER_PREFIX.length)
      const st = candidate.indexOf('\x1b\\', COMMAND_MARKER_PREFIX.length)
      const terminatorStart = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st)
      if (terminatorStart === -1) {
        if (
          candidate.length >
          COMMAND_MARKER_PREFIX.length + MAX_NONCE_CHARS + MAX_ENCODED_CHARS + 2
        ) {
          appendData(items, candidate[0] as string)
          input = candidate.slice(1)
          continue
        }
        this.held = candidate
        break
      }
      const terminatorLength = terminatorStart === st ? 2 : 1
      const markerLength = terminatorStart + terminatorLength
      const fields = candidate.slice(COMMAND_MARKER_PREFIX.length, terminatorStart).split(';')
      const command =
        fields.length === 2 && fields[0]!.length <= MAX_NONCE_CHARS
          ? decodeCommand(fields[1] as string)
          : null
      if (command === null) {
        // Why dropped and not forwarded: nothing else may emit this private prefix, and
        // the row carries the nonce — re-emitting it would publish the nonce downstream.
      } else {
        items.push({
          kind: 'command-started',
          rawLength: markerLength,
          event: {
            agent: recognizeAgentProcessFromCommandLine(command)?.agent ?? null,
            trusted: this.expectedNonce !== null && fields[0] === this.expectedNonce
          }
        })
      }
      input = candidate.slice(markerLength)
    }
    return items
  }

  drain(): { data: string; rawLength: number; transformed: boolean } {
    const held = this.held
    this.held = ''
    // A full private prefix is Orca-owned and may contain the nonce; only partial-prefix bytes are safe to release.
    const privateCandidate = held.startsWith(COMMAND_MARKER_PREFIX)
    return {
      data: privateCandidate ? '' : held,
      rawLength: held.length,
      transformed: privateCandidate
    }
  }
}
