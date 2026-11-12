import type * as ClaudeSdk from '@anthropic-ai/claude-agent-sdk'
import {
  agentSessionAdvisoryReportSchema,
  type AgentSessionAdvisoryReporter
} from '../../../shared/agent-session/agent-session-advisory-report'

const refused = () => ({
  isError: true,
  content: [{ type: 'text' as const, text: 'Advice report unavailable.' }]
})
const submitted = () => ({
  content: [{ type: 'text' as const, text: 'Advice submitted.' }],
  structuredContent: { state: 'submitted' }
})

export function createClaudeAdvisoryReportTool(
  sdk: Pick<typeof ClaudeSdk, 'tool'>,
  ended: () => boolean,
  publish: AgentSessionAdvisoryReporter
) {
  let attempt:
    | { key: string; result: Promise<ReturnType<typeof refused> | ReturnType<typeof submitted>> }
    | undefined
  return sdk.tool(
    'report_advice',
    'Submit one bounded finding to the owner. A recommendation needs evidence, uncertainty, and the next discriminating test.',
    agentSessionAdvisoryReportSchema.shape,
    async (input) => {
      if (ended()) {
        return refused()
      }
      const parsed = agentSessionAdvisoryReportSchema.safeParse(input)
      const report = parsed.success ? parsed.data : { status: 'inconclusive' as const }
      const key = JSON.stringify(report)
      if (attempt) {
        return attempt.key === key ? attempt.result : refused()
      }
      const result = Promise.resolve().then(async () => {
        if (ended()) {
          return refused()
        }
        try {
          await publish(report)
          return submitted()
        } catch {
          // A lost backend result may follow a committed report; never repeat its effect.
          return refused()
        }
      })
      attempt = { key, result }
      return result
    }
  )
}
