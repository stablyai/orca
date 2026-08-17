import { fileURLToPath } from 'node:url'
import type { NativeChatBlock, NativeChatImageRefBlock } from '../../shared/native-chat-types'
import { asRecord, extractString, parseJsonObject } from '../ai-vault/session-scanner-values'

// Why: OpenCode `part` rows → NativeChatBlock mapping, split from the SQLite
// query module so each stays under the repo's file-size cap. Electron-free:
// runs on the OpenCode SQLite worker thread (#8864).

export type OpenCodePartRow = {
  message_id: string
  time_updated: number
  data: string
}

/** Map one message's part rows to renderable blocks. */
export function opencodeMessageBlocks(partRows: OpenCodePartRow[]): NativeChatBlock[] {
  const blocks: NativeChatBlock[] = []
  for (const partRow of partRows) {
    const part = parseJsonObject(partRow.data)
    if (!part) {
      continue
    }
    switch (part.type) {
      case 'text': {
        // Why: OpenCode stamps harness-injected context (session bootstrap,
        // memory recall) with `synthetic: true`; the TUI never shows it.
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
          blocks.push({ type: 'text', text })
        }
        break
      }
      case 'tool': {
        blocks.push(...opencodeToolBlocks(part))
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
  return blocks
}

/** A file part maps onto an image ref for image mimes — the pasted-image
 *  parity claude/codex chats already have. Non-image files and image parts
 *  without a usable url render nothing, like the other decoders. */
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

/** A tool part carries the invocation AND its captured result in `state`. */
function opencodeToolBlocks(part: Record<string, unknown>): NativeChatBlock[] {
  const name = extractString(part.tool) ?? 'tool'
  const state = asRecord(part.state)
  const blocks: NativeChatBlock[] = [
    {
      type: 'tool-call',
      name,
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
    output: typeof output === 'string' ? output : '',
    ...(error != null ? { isError: true } : {})
  })
  return blocks
}
