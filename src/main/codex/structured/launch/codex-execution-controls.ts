import { agentSessionExecutionPolicySchema } from '../../../../shared/agent-session/agent-session-execution-policy'
import type { AgentSessionExecutionPolicy } from '../../../../shared/agent-session/agent-session-execution-policy'
import { escapeTomlBasicString } from '../../configuration/toml/config-toml-syntax'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { isNativeLocalLocation } from '../../../../shared/execution-host'

export function supportsCodexExecutionPolicy(
  location: AgentSessionRecord['location'],
  agent: string
) {
  return (
    agent === 'codex' &&
    process.platform === 'darwin' &&
    location.workspaceKind === 'folder' &&
    isNativeLocalLocation(location)
  )
}

export function codexExecutionLaunch(record: AgentSessionRecord) {
  if (!record.executionPolicy) {
    return undefined
  }
  const policy = agentSessionExecutionPolicySchema.parse(record.executionPolicy)
  const remaining = policy.deadlineAt - Date.now()
  if (
    record.provider !== 'codex' ||
    record.location.executionHostId !== 'local' ||
    record.location.wslDistro !== null ||
    record.location.workspaceKind !== 'folder' ||
    record.providerHandleChain.length ||
    record.forkedFrom ||
    record.rewind ||
    record.providerContextBoundary ||
    record.conversationCommand ||
    remaining <= 0 ||
    remaining > 300_000 ||
    record.options?.model !== policy.model ||
    record.options?.effort !== policy.effort
  ) {
    throw new Error('Invalid bounded Codex launch.')
  }
  const profileId = `orca-bounded-${record.sessionId}`
  const settings = [
    'forced_login_method="chatgpt"',
    'model_provider="openai"',
    'openai_base_url="https://chatgpt.com/backend-api/codex"',
    'service_tier="default"',
    'web_search="disabled"',
    `model_reasoning_effort="${escapeTomlBasicString(policy.effort)}"`,
    'notify=[]',
    'shell_environment_policy={inherit="none",set={}}',
    'analytics.enabled=false',
    'otel.exporter="none"',
    'otel.trace_exporter="none"',
    ...[
      'hooks',
      'codex_hooks',
      'apps',
      'plugins',
      'collab',
      'enable_fanout',
      'browser_use',
      'computer_use'
    ].map((name) => `features.${name}=false`)
  ]
  return {
    policy,
    profileId,
    args: [
      ...codexExecutionProfileArgs(profileId, policy.access),
      ...settings.flatMap((setting) => ['-c', setting])
    ]
  }
}

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
  const stop = () => {
    if (ended) {
      return
    }
    ended = true
    clearTimeout(timer)
    void close().then(
      (proven) => {
        if (!proven) {
          onFault(new Error('Bounded Codex process exit unproven.'))
        }
      },
      () => onFault(new Error('Bounded Codex process exit unproven.'))
    )
  }
  const timer = setTimeout(stop, remaining)
  timer.unref()
  return {
    stop,
    isOpen: () => !ended && Date.now() < policy.deadlineAt,
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
