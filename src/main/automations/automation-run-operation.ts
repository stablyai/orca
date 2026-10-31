import { canonicalAgentSessionDigest } from '../../shared/agent-session-mutation-envelope'
import type { AutomationRun } from '../../shared/automations-types'

export const AUTOMATION_AGENT_CALLER = { kind: 'local-cli' } as const

export function automationRunOperationId(
  run: Pick<AutomationRun, 'id' | 'createdAt'>,
  purpose: 'fresh-launch' | 'reuse-send'
): string {
  const entropy = canonicalAgentSessionDigest({
    domain: `automation:${purpose}`,
    runId: run.id
  }).slice(0, 32)
  return `${run.createdAt}-${entropy}`
}
