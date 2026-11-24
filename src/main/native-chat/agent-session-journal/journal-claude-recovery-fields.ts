import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'

export type Field = {
  kind: 'text' | 'tool-result' | 'tool-input' | 'tool-output'
  blockIndex: number | null
}
type SavedField = { field: Field; value: unknown; callId?: string }

function toolInput(
  blockIndex: number | null,
  call: { callId?: string; input: unknown }
): SavedField | undefined {
  return call.callId
    ? { field: { kind: 'tool-input', blockIndex }, value: call.input ?? null, callId: call.callId }
    : undefined
}

export function savedField(body: AgentJournalItemBody, index: number): SavedField | undefined {
  if (body.kind === 'tool-call') {
    if (index === 0) {
      return toolInput(null, body)
    }
    if (index === 1 && body.output && !body.output.truncated) {
      return { field: { kind: 'tool-output', blockIndex: null }, value: body.output.head }
    }
  }
  if (body.kind === 'message') {
    const block = body.blocks[index]
    if (block?.type === 'text') {
      return { field: { kind: 'text', blockIndex: index }, value: block.text }
    }
    if (block?.type === 'tool-result') {
      return { field: { kind: 'tool-result', blockIndex: index }, value: block.output }
    }
    if (block?.type === 'tool-call') {
      return toolInput(index, block)
    }
  }
  return undefined
}
