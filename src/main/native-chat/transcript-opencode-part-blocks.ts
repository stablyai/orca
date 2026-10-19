import { fileURLToPath } from 'node:url'
import type {
  NativeChatBlock,
  NativeChatImageRefBlock,
  NativeChatMessage,
  NativeChatTextBlock
} from '../../shared/native-chat-types'
import { agentSessionHostStatusBody } from '../../shared/agent-session-host-status-rows'
import { asRecord, extractString, parseJsonObject } from '../ai-vault/session-scanner-values'
// query module so each stays under the repo's file-size cap. Electron-free:
// runs on the OpenCode SQLite worker thread (#8864).

export type OpenCodePartRow = {
  message_id: string
  time_updated: number
  data: string | null
}

export const OPENCODE_TRANSCRIPT_MAX_ROW_BYTES = 2 * 1024 * 1024

export function opencodeMessages(
  message: Pick<NativeChatMessage, 'id' | 'role' | 'timestamp'>,
  partRows: OpenCodePartRow[],
  additionalBlocks: NativeChatBlock[] = []
): NativeChatMessage[] {
  const { blocks, reasoning, notices } = opencodeMessageContent(partRows)
  blocks.push(...additionalBlocks)
  const messages: NativeChatMessage[] = []
  if (reasoning.length > 0) {
    messages.push({
      ...message,
      id: blocks.length > 0 || notices.length > 0 ? `${message.id}:reasoning` : message.id,
      role: 'reasoning',
      blocks: reasoning,
      source: 'transcript'
    })
  }
  if (blocks.length > 0) {
    messages.push({ ...message, blocks, source: 'transcript' })
  }
  if (notices.length > 0) {
    messages.push({
      ...message,
      id: messages.length > 0 ? `${message.id}:omission` : message.id,
      role: 'system',
      blocks: notices,
      source: 'transcript'
    })
  }
  return messages
}

function opencodeMessageContent(partRows: OpenCodePartRow[]): {
  blocks: NativeChatBlock[]
  reasoning: NativeChatBlock[]
  notices: NativeChatTextBlock[]
} {
  const blocks: NativeChatBlock[] = []
  const reasoning: NativeChatBlock[] = []
  const notices: NativeChatTextBlock[] = []
  for (const partRow of partRows) {
    if (partRow.data === null) {
      const { text, presentation } = agentSessionHostStatusBody('history-item-too-large')
      notices.push({ type: 'text', text, presentation })
      continue
    }
    const part = parseJsonObject(partRow.data)
    if (!part) {
      continue
    }
    switch (part.type) {
      case 'text': {
        if (part.synthetic === true) {
          break
        }
        const text = extractString(part.text)
        if (text) {
          blocks.push({ type: 'text', text })
        }
        break
      }
      case 'reasoning': {
        const text = extractString(part.text)
        if (text) {
          reasoning.push({ type: 'text', text })
        }
        break
      }
      case 'tool': {
        blocks.push(...opencodeToolBlocks(part))
        break
      }
      case 'patch': {
        const files = Array.isArray(part.files)
          ? part.files.filter((file): file is string => typeof file === 'string')
          : []
        blocks.push({
          type: 'tool-call',
          name: 'patch',
          state: 'completed',
          input: { hash: extractString(part.hash), files }
        })
        break
      }
      case 'file': {
        const block = opencodeFileBlock(part)
        if (block) {
          blocks.push(block)
        }
        break
      }
      default:
        // step-start / snapshot / unknown bookkeeping parts render nothing.
        break
    }
  }
  return { blocks, reasoning, notices }
}

function opencodeFileBlock(part: Record<string, unknown>): NativeChatImageRefBlock | null {
  const mime = extractString(part.mime)
  if (!mime?.startsWith('image/')) {
    return null
  }
  const url = extractString(part.url)
  if (!url) {
    return null
  }
  const alt = extractString(part.filename)
  const withAlt = alt ? { alt } : {}
  if (url.startsWith('data:') || /^https?:\/\//.test(url)) {
    return { type: 'image-ref', url, ...withAlt }
  }
  if (url.startsWith('file://')) {
    try {
      return { type: 'image-ref', path: fileURLToPath(url), ...withAlt }
    } catch {
      // A malformed file URL still renders as an opaque ref.
      return { type: 'image-ref', url, ...withAlt }
    }
  }
  return { type: 'image-ref', path: url, ...withAlt }
}

function opencodeToolBlocks(part: Record<string, unknown>): NativeChatBlock[] {
  const name = extractString(part.tool) ?? 'tool'
  const state = asRecord(part.state)
  const callId = extractString(part.callID) ?? extractString(part.id)
  const status = state?.status
  const lifecycle = status === 'completed' ? 'completed' : status === 'error' ? 'failed' : 'running'
  const blocks: NativeChatBlock[] = [
    {
      type: 'tool-call',
      name,
      ...(callId ? { callId } : {}),
      state: lifecycle,
      input: state ? state.input : undefined
    }
  ]
  if (!state) {
    return blocks
  }
  const output = state.output
  const error = state.error
  if (typeof output !== 'string' && error == null) {
    // pending / running: the result has not been captured yet.
    return blocks
  }
  blocks.push({
    type: 'tool-result',
    ...(callId ? { callId } : {}),
    output:
      typeof output === 'string'
        ? output
        : typeof error === 'string'
          ? error
          : error != null
            ? JSON.stringify(error)
            : '',
    ...(error != null ? { isError: true } : {})
  })
  return blocks
}
