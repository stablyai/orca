import { z } from 'zod'
import { readAnswerSenderSnapshot } from '../../../../../shared/agent-session/answer-sender-snapshot'
import { agentMessageSenderName } from '../../../../../shared/agent-session/agent-session-message-source'

const reportSchema = z.object({
  version: z.literal(1),
  name: z.string().max(200).nullable(),
  agent: z.string().min(1).max(40).optional(),
  relation: z.enum(['worker', 'coordinator', 'none']).optional()
})

export function readAnswerSenderRelayReport(
  value: unknown
): z.infer<typeof reportSchema> | undefined {
  try {
    const decoded: unknown = typeof value === 'string' ? JSON.parse(value) : value
    const parsed = reportSchema.safeParse(decoded)
    if (parsed.success && Buffer.byteLength(JSON.stringify(parsed.data)) <= 2048) {
      return parsed.data
    }
  } catch {
    /* Optional facts cannot refuse the answer. */
  }
  return undefined
}

export function answerSenderRelayReport(snapshot: unknown): string | undefined {
  const sender = readAnswerSenderSnapshot(snapshot)
  if (!sender) {
    return
  }
  const report = readAnswerSenderRelayReport({
    version: 1,
    name: sender.name,
    agent: sender.agent,
    relation: sender.relation
  })
  return report ? JSON.stringify(report) : undefined
}

export function importedAnswerSenderSnapshot(value: unknown, role: string): string | undefined {
  const report = readAnswerSenderRelayReport(value)
  return report
    ? JSON.stringify({
        version: 1,
        sender: {
          party: { address: role, terminalHandle: null, orcaSessionId: null },
          name: agentMessageSenderName(report.name),
          ...(report.agent ? { agent: report.agent } : {}),
          ...(report.relation ? { relation: report.relation } : {})
        }
      })
    : undefined
}
