/**
 * What a hidden bridged pane's dropped output must still deliver: terminal queries the window's
 * xterm answers (and the mode-2031 toggles its colour-scheme registry reads), OSC sequences (command marks, titles, cwd, notifications) and bells. None paint,
 * and main holds no model of these terminals to stand in for the window.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 */
import {
  findCsiFinalByteIndex,
  isStatefulRendererReplyCsiQuery
} from '../../../shared/terminal-reply-query-extraction'
import { isReplayableCsi } from '../../../shared/terminal-reply-query-scan'

const MAX_CSI_CHARS = 64
// Why bounded: an inline image is one huge OSC, and it paints.
const MAX_OSC_CHARS = 4096

/** Carried between chunks: a sequence split across them, or an oversized OSC being skipped. */
export type OutputSalvageState = { tail: string; skippingOsc: boolean }

export const EMPTY_OUTPUT_SALVAGE: OutputSalvageState = { tail: '', skippingOsc: false }

/** The OSC terminator's end, or -1 while it is still to come; `aborted` when ESC cut it short. */
function oscEnd(input: string, from: number): { end: number; aborted: boolean } {
  for (let index = from; index < input.length; index++) {
    const char = input[index]
    if (char === '\x07') {
      return { end: index + 1, aborted: false }
    }
    if (char === '\x1b') {
      if (index + 1 >= input.length) {
        return { end: -1, aborted: false }
      }
      return input[index + 1] === '\\'
        ? { end: index + 2, aborted: false }
        : { end: index, aborted: true }
    }
  }
  return { end: -1, aborted: false }
}

function bells(text: string): string {
  let kept = ''
  for (let index = text.indexOf('\x07'); index !== -1; index = text.indexOf('\x07', index + 1)) {
    kept += '\x07'
  }
  return kept
}

export type OutputSalvage = {
  kept: string
  /** Queries answered from cursor or mode state, which the window's dropped output left stale. */
  stateful: string
  state: OutputSalvageState
}

export function salvageHiddenOutput(data: string, state: OutputSalvageState): OutputSalvage {
  let input = state.tail + data
  let kept = ''
  let stateful = ''
  let offset = 0
  if (state.skippingOsc) {
    const skipped = oscEnd(input, 0)
    if (skipped.end === -1) {
      return {
        kept,
        stateful,
        state: { tail: input.endsWith('\x1b') ? '\x1b' : '', skippingOsc: true }
      }
    }
    input = input.slice(skipped.end)
  }
  while (offset < input.length) {
    const escape = input.indexOf('\x1b', offset)
    kept += bells(input.slice(offset, escape === -1 ? input.length : escape))
    if (escape === -1) {
      break
    }
    if (escape + 1 >= input.length) {
      return { kept, stateful, state: { tail: input.slice(escape), skippingOsc: false } }
    }
    const introducer = input[escape + 1]
    if (introducer === '[') {
      const final = findCsiFinalByteIndex(input, escape + 2)
      if (final === -1) {
        const tail = input.slice(escape)
        return {
          kept,
          stateful,
          state: { tail: tail.length <= MAX_CSI_CHARS ? tail : '', skippingOsc: false }
        }
      }
      const sequence = input.slice(escape, final + 1)
      if (isStatefulRendererReplyCsiQuery(sequence) || sequence === '\x1b[?6n') {
        stateful += sequence
      } else if (isReplayableCsi(sequence)) {
        kept += sequence
      }
      offset = final + 1
      continue
    }
    if (introducer === ']') {
      const osc = oscEnd(input, escape + 2)
      if (osc.end === -1) {
        const tail = input.slice(escape)
        return tail.length <= MAX_OSC_CHARS
          ? { kept, stateful, state: { tail, skippingOsc: false } }
          : {
              kept,
              stateful,
              state: { tail: tail.endsWith('\x1b') ? '\x1b' : '', skippingOsc: true }
            }
      }
      if (!osc.aborted && osc.end - escape <= MAX_OSC_CHARS) {
        kept += input.slice(escape, osc.end)
      }
      offset = osc.end
      continue
    }
    if (introducer === 'P') {
      const terminator = input.indexOf('\x1b\\', escape + 2)
      if (terminator === -1) {
        const tail = input.slice(escape)
        return {
          kept,
          stateful,
          state: { tail: tail.length <= MAX_OSC_CHARS ? tail : '', skippingOsc: false }
        }
      }
      const body = input.slice(escape + 2, terminator)
      const sequence = input.slice(escape, terminator + 2)
      // DECRQSS reads the pen and margins; XTGETTCAP reads only capabilities.
      if (body.startsWith('$q')) {
        stateful += sequence
      } else if (body.startsWith('+q')) {
        kept += sequence
      }
      offset = terminator + 2
      continue
    }
    offset = escape + 2
  }
  return { kept, stateful, state: EMPTY_OUTPUT_SALVAGE }
}
