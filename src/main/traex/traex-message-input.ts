import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/options/structured-agent-session-option-error'

export function traexMessageInput(body: AgentJournalMessageItem): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = []
  for (const block of body.blocks) {
    if (block.type === 'text') {
      input.push({ type: 'text', text: block.text })
    } else if (block.type === 'image-ref' && block.path) {
      input.push({ type: 'localImage', path: block.path })
    } else if (block.type === 'image-ref' && block.url) {
      input.push({ type: 'image', url: block.url })
    } else {
      throw new AgentSessionOptionRejectedError('TRAE CLI cannot send this attachment')
    }
  }
  for (const skill of body.skills ?? []) {
    input.push({ type: 'skill', name: skill.name, path: skill.path })
  }
  return input
}
