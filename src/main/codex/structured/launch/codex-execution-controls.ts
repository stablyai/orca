import { agentSessionExecutionPolicySchema } from '../../../../shared/agent-session/agent-session-execution-policy'
import type { AgentSessionExecutionPolicy } from '../../../../shared/agent-session/agent-session-execution-policy'
import { escapeTomlBasicString } from '../../configuration/toml/config-toml-syntax'

export function codexExecutionProfileArgs(
  profileId: string,
  access: AgentSessionExecutionPolicy['access']
): string[] {
  const writable = access === 'workspace'
  const parent = writable ? ':workspace' : ':read-only'
  const grant = writable ? 'write' : 'read'
  return [
    '-c',
    `permissions={"${escapeTomlBasicString(profileId)}"={extends="${parent}",filesystem={":root"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny",":workspace_roots"={"."="${grant}"}},network={enabled=false}}}`
  ]
}

/** The timer requests teardown; only the process owner's observations establish exit. */
export function createCodexExecutionControls(
  input: unknown,
  close: () => Promise<boolean>,
  onFault: (reason: Error) => void
) {
  const policy = agentSessionExecutionPolicySchema.parse(input)
  const remaining = policy.deadlineAt - Date.now()
  if (remaining <= 0 || remaining > 300_000) {
    throw new Error('Invalid bounded Codex deadline.')
  }
  let ended = false
  const timer = setTimeout(() => {
    ended = true
    void close().then(
      (proven) => {
        if (!proven) {
          onFault(new Error('Bounded Codex process exit unproven.'))
        }
      },
      () => onFault(new Error('Bounded Codex process exit unproven.'))
    )
  }, remaining)
  timer.unref()
  return {
    assertOpen: () => {
      if (ended || Date.now() >= policy.deadlineAt) {
        throw new Error('Bounded Codex deadline reached.')
      }
    },
    end: () => {
      ended = true
      clearTimeout(timer)
    }
  }
}
