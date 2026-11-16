import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat/native-chat-types'

// One transcript line stays bounded; `agentSession.item` remains the full-fidelity escape.
const LINE_TEXT_LIMIT = 4000

function clip(text: string): string {
  return text.length > LINE_TEXT_LIMIT
    ? `${text.slice(0, LINE_TEXT_LIMIT)}\n…[${text.length} chars]`
    : text
}

function messageBlocksText(blocks: readonly NativeChatBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'tool-call':
        parts.push(`⚙ ${block.name}`)
        break
      case 'tool-result':
        parts.push(`→ ${block.output}`)
        break
      case 'image-ref':
        parts.push('[image]')
        break
      case 'subagent':
      case 'subagent-group':
        parts.push('[subagent]')
        break
      case 'background-task':
        parts.push('[background task]')
        break
    }
  }
  return parts.join('\n')
}

function senderLabel(sender: { name: string | null; agent?: string }): string {
  return sender.name ?? sender.agent ?? 'agent'
}

/** Render one journal row as transcript lines, prefixed with the producing subagent when it is not the session root. */
export function journalItemCliLines(item: AgentJournalRenderItem): string[] {
  const owner = item.agentId ? `[${item.agentId}] ` : ''
  const body = item.body
  switch (body.kind) {
    case 'message': {
      const text = messageBlocksText(body.blocks)
      if (text.length === 0) {
        return []
      }
      const role = body.role === 'reasoning' ? 'reasoning' : body.role
      return [`${owner}${role}: ${clip(text)}`]
    }
    case 'tool-call': {
      const input = body.input === undefined ? '' : ` ${clip(JSON.stringify(body.input))}`
      const output = body.output && body.output.head.length > 0 ? `\n${clip(body.output.head)}` : ''
      const cut = body.output?.truncated ? ' [truncated]' : ''
      return [`${owner}tool ${body.name} (${body.state}):${input}${output}${cut}`]
    }
    case 'diff': {
      const cut = body.patch.truncated ? ' [truncated]' : ''
      return [`${owner}diff ${body.path}${cut}`]
    }
    case 'status': {
      const failure = 'failure' in body && body.failure ? ` ${body.failure}` : ''
      return [`${owner}status${failure}: ${clip(body.text)}`]
    }
    case 'turn': {
      const outcome = body.outcome ? ` outcome=${JSON.stringify(body.outcome)}` : ''
      return [`${owner}turn ${body.state}${outcome}`]
    }
    case 'approval': {
      const choice = body.resolution.selectedOptionId ?? body.resolution.state
      return [`${owner}approval ${body.title} → ${choice}`]
    }
    case 'question': {
      const choice = body.resolution.selectedOptionId ?? body.resolution.state
      return [`${owner}question ${body.question} → ${choice}`]
    }
    case 'agent-start':
      return [`${owner}agent-start ${senderLabel(body.worker)}: ${clip(body.task)}`]
    case 'agent-handoff':
      return [`${owner}agent-handoff ${senderLabel(body.agent)}: ${clip(body.task)}`]
  }
}
