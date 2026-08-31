export type MissionAttentionMessage = {
  id: string
  type: string
  subject: string
  body?: string
  payload?: string
}

export type MissionAttention = {
  runId: string
  deliveryId: string
  messages: readonly MissionAttentionMessage[]
}

export type MissionAttentionReporter = (attention: MissionAttention) => void | Promise<void>

export function reportMissionAttentionToStderr(attention: MissionAttention): void {
  console.error(formatMissionAttention(attention))
}

export function formatMissionAttention(attention: MissionAttention, from?: string): string {
  return attention.messages
    .map((message) => {
      const reply = from
        ? `Reply: orca orchestration reply --id ${message.id} --run ${attention.runId} --from ${from} --body "<your reply>"`
        : `Inspect or reply with: orca orchestration reply --id ${message.id} --run ${attention.runId} --body "<your reply>"`
      return [
        `Mission attention (${message.type})`,
        `Run: ${attention.runId}; delivery: ${attention.deliveryId}; message: ${message.id}.`,
        `Subject: ${JSON.stringify(message.subject)}`,
        `Body: ${JSON.stringify(message.body ?? '')}`,
        `Payload: ${JSON.stringify(message.payload ?? '')}`,
        reply
      ].join('\n')
    })
    .join('\n\n')
}
