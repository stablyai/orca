import { sanitizeToolInput } from './native-chat-tool-input-sanitize'
import {
  MAX_SUBAGENT_FIELD_CHARS,
  normalizeSubagentState
} from '../../../../shared/native-chat-subagent-summary'
import type { NativeChatBlock, NativeChatSubagentState } from '../../../../shared/native-chat-types'
import { boundSubagentEntryId } from '../../../native-chat/subagent-entry-id-bounds'
import type { RpcContext } from '../core'
import { sanitizeNativeChatRpcImageBlock } from './native-chat-rpc-image-block'

// Why: the mobile-only payload diet. Inline image bytes are kept off every RPC
// transport; everything below that only applies to `mobile` clients, whose
// renderer previews block bodies rather than showing them whole.

// Why: a single tool result (a big file read, a long diff) can be hundreds of KB.
// The mobile view only previews tool block bodies, so truncate them on the wire
// to keep the payload small; the marker tells the user content was clipped.
const MOBILE_BLOCK_CHAR_CAP = 4000
// Why: text blocks are the message body itself, rendered in full by the chat
// view — a preview-sized cap cut long assistant replies mid-sentence with no way
// to read on (STA-3230). Keep only a generous safety ceiling: a transcript
// record can legally reach 2MB, and shipping that much markdown in one block
// would freeze the phone.
const MOBILE_TEXT_BLOCK_CHAR_CAP = 64_000
// Why: a spawn group's roster is metadata, not a body — provider-supplied agent
// paths and an open-string lifecycle whose schema declares no maximum, so a
// journal from a newer build can carry more children and longer strings than
// this build ever writes.
const MOBILE_SUBAGENT_CAP = 64
const TRUNCATION_MARKER = '\n… (truncated)'

function clip(text: string, cap: number): string {
  return text.length > cap ? text.slice(0, cap) + TRUNCATION_MARKER : text
}

export function sanitizeNativeChatRpcBlock(
  block: NativeChatBlock,
  clientKind: RpcContext['clientKind']
): NativeChatBlock {
  if (block.type === 'image-ref') {
    return sanitizeNativeChatRpcImageBlock(block)
  }
  if (clientKind !== 'mobile') {
    return block
  }
  if (block.type === 'text') {
    return block.text.length > MOBILE_TEXT_BLOCK_CHAR_CAP
      ? { ...block, text: clip(block.text, MOBILE_TEXT_BLOCK_CHAR_CAP) }
      : block
  }
  if (block.type === 'tool-result') {
    return block.output.length > MOBILE_BLOCK_CHAR_CAP
      ? { ...block, output: clip(block.output, MOBILE_BLOCK_CHAR_CAP) }
      : block
  }
  if (block.type === 'tool-call') {
    return { ...block, input: sanitizeToolInput(block.input) }
  }
  if (block.type === 'subagent-group') {
    return {
      ...block,
      groupId: clip(block.groupId, MAX_SUBAGENT_FIELD_CHARS),
      agents: block.agents.slice(0, MOBILE_SUBAGENT_CAP).map((agent) => ({
        ...agent,
        // The id is the roster KEY: a prefix clip would merge two children, so
        // it takes the shared digest bound the other wires use.
        id: boundSubagentEntryId(agent.id),
        label: clip(agent.label, MAX_SUBAGENT_FIELD_CHARS),
        state: clipSubagentState(agent.state)
      }))
    }
  }
  return block
}

/** A state too long to be one this build knows names no state at all, which is
 *  what `unverifiable` records — clipping it would ship a truncated word. */
function clipSubagentState(value: NativeChatSubagentState): NativeChatSubagentState {
  return value.length > MAX_SUBAGENT_FIELD_CHARS ? normalizeSubagentState(value) : value
}
