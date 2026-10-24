import type { AgentSessionDeltaSource } from './agent-session-delta-coalescer'
import { truncateStreamPrefix } from './agent-session-streamed-text-bounds'

/** Views stop at their captured count even as the current owner appends more cuts. */
export type AgentSessionTextCuts = {
  blocks: Uint32Array[]
  count: number
}

export function appendAgentSessionTextCut(cuts: AgentSessionTextCuts, offset: number): void {
  const block = Math.floor(cuts.count / 256)
  cuts.blocks[block] ??= new Uint32Array(256)
  cuts.blocks[block][cuts.count % 256] = offset
  cuts.count += 1
}

export function agentSessionTextPairBoundary(left: number, right: number): boolean {
  return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff
}

export function* agentSessionTextEncodingChunks(
  text: string,
  cuts: AgentSessionTextCuts
): Generator<string> {
  let start = 0
  for (let index = 0; index < cuts.count; index += 1) {
    const end = cuts.blocks[Math.floor(index / 256)][index % 256]
    if (end > text.length) {
      break
    }
    yield text.slice(start, end)
    start = end
  }
  yield text.slice(start)
}

export function truncateAgentSessionTextEncoding(
  text: string,
  cuts: AgentSessionTextCuts,
  maxBytes: number
) {
  return truncateStreamPrefix([...agentSessionTextEncodingChunks(text, cuts)], '', maxBytes)
}

export function measureAgentSessionText(text: string): AgentSessionDeltaSource {
  const bytes = Buffer.byteLength(text, 'utf8')
  return {
    observedBytes: bytes,
    truncated: false,
    length: text.length,
    bytes,
    encodedBytes: Buffer.byteLength(JSON.stringify(text), 'utf8') - 2,
    lastCodeUnit: text.charCodeAt(text.length - 1)
  }
}

export function extendAgentSessionTextSource(
  previous: AgentSessionDeltaSource | undefined,
  suffix: string,
  localCuts?: AgentSessionTextCuts
): AgentSessionDeltaSource {
  const cuts = { blocks: previous?.cuts?.blocks ?? [], count: previous?.cuts?.count ?? 0 }
  const paired = agentSessionTextPairBoundary(
    previous?.lastCodeUnit ?? Number.NaN,
    suffix.charCodeAt(0)
  )
  if (paired) {
    appendAgentSessionTextCut(cuts, previous?.length ?? 0)
  }
  for (let index = 0; localCuts && index < localCuts.count; index++) {
    appendAgentSessionTextCut(
      cuts,
      (previous?.length ?? 0) + localCuts.blocks[Math.floor(index / 256)][index % 256]
    )
  }
  const next = measureAgentSessionText(suffix)
  return {
    ...next,
    cuts,
    length: (previous?.length ?? 0) + suffix.length,
    bytes: (previous?.bytes ?? 0) + next.bytes + 2 * (localCuts?.count ?? 0),
    encodedBytes: (previous?.encodedBytes ?? 0) + next.encodedBytes - (paired ? 8 : 0),
    lastCodeUnit: suffix.length ? next.lastCodeUnit : previous?.lastCodeUnit,
    observedBytes: (previous?.observedBytes ?? 0) + next.bytes + 2 * (localCuts?.count ?? 0),
    truncated: previous?.truncated ?? false
  }
}
