import { canonicalAgentSessionDigest } from '../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'

export const AUTOMATION_AGENT_CALLER = { kind: 'local-cli' } as const

export function automationRunOperationId(
  run: Pick<AutomationRun, 'id' | 'createdAt'>,
  /** `run-message`: the prompt a run sends into a chat it does not launch, findable after a restart. */
  purpose: 'fresh-launch' | 'reuse-send' | 'run-message'
): string {
  const entropy = canonicalAgentSessionDigest({
    domain: `automation:${purpose}`,
    runId: run.id
  }).slice(0, 32)
  return `${run.createdAt}-${entropy}`
}
