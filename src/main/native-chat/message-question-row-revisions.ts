import type { NativeChatMessage } from '../../shared/native-chat-types'
import {
  parseAskFromToolInput,
  type AsyncQuestionContributor
} from '../../shared/native-chat/input/native-chat-ask'

/** Revisions reuse canonical row/slot addresses; raw call IDs only dedupe the current parser segment. */
export class MessageQuestionRowRevisions {
  private readonly owners = new Map<string, Map<string, string>>()

  reset(owner?: string): void {
    if (owner === undefined) {
      this.owners.clear()
    } else {
      this.owners.delete(owner)
    }
  }

  read(message: NativeChatMessage, context: string, owner: string): AsyncQuestionContributor[] {
    const calls = this.owners.get(owner) ?? new Map<string, string>()
    this.owners.set(owner, calls)
    const result: AsyncQuestionContributor[] = []
    let slot = 0
    for (const block of message.blocks) {
      if (block.type !== 'tool-call') {
        continue
      }
      const parsed = parseAskFromToolInput(block.name, block.input)
      if (!parsed?.replyAsMessage) {
        continue
      }
      const callSlot = slot++
      const address = JSON.stringify([context, message.id, callSlot])
      if (block.callId !== undefined) {
        const prior = calls.get(block.callId)
        if (prior !== undefined && prior !== address) {
          continue
        }
        calls.set(block.callId, address)
      }
      result.push({
        sourceRowId: message.id,
        callSlot,
        timestamp: message.timestamp,
        questions: parsed.questions,
        responseMode: 'message'
      })
    }
    return result
  }
}
