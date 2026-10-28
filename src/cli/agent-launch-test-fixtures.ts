import {
  AGENT_LAUNCH_RUNTIME_CAPABILITIES,
  PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY
} from '../shared/agent-launch-runtime-capability'
import { okFixture } from './test-fixtures'

export function agentLaunchHostFixture(additionalCapabilities: readonly string[] = []) {
  return okFixture('req_status', {
    capabilities: [
      ...AGENT_LAUNCH_RUNTIME_CAPABILITIES.filter(
        (capability) => capability !== PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY
      ),
      ...additionalCapabilities
    ]
  })
}

export function agentLaunchFixture(worktreeId: string, warning?: string) {
  return okFixture('req_launch', {
    outcome: { kind: 'structured', sessionId: 'codex_1', handle: 'agent_1' },
    worktreeId,
    receipt: {
      mode: 'structured',
      preferred: 'structured',
      reason: 'user_default',
      detail: 'Started a structured chat session, the default for new agent tabs in your settings.'
    },
    prompt: { delivery: 'submit', outcome: 'journaled', messageId: 'msg_1' },
    ...(warning ? { warning } : {})
  })
}
