import type * as ClaudeSdk from '@anthropic-ai/claude-agent-sdk'
import { agentSessionAdvisoryPolicySchema } from '../../../shared/agent-session/agent-session-advisory-policy'
import { createClaudeAdvisoryArtifactServer } from './claude-advisory-artifacts'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'

const TOOLS = new Set(['mcp__orca_advisor__read_artifact', 'mcp__orca_advisor__search_artifacts'])

export function claudeAdvisoryLaunchPolicy(record: AgentSessionRecord) {
  if (!record.advisoryPolicy) {
    return undefined
  }
  if (
    record.location.workspaceKind !== 'folder' ||
    record.providerHandleChain.length ||
    record.forkedFrom ||
    record.rewind ||
    record.providerContextBoundary ||
    record.conversationCommand
  ) {
    throw new Error('Advisor requires a fresh folder conversation.')
  }
  return structuredClone(record.advisoryPolicy)
}

export function createClaudeAdvisoryControls(
  input: unknown,
  sdk: Pick<typeof ClaudeSdk, 'createSdkMcpServer' | 'tool'>,
  selected: Pick<
    ClaudeSdk.Options,
    'model' | 'effort' | 'sessionId' | 'resume' | 'forkSession' | 'resumeSessionAt'
  >
) {
  const parsed = agentSessionAdvisoryPolicySchema.safeParse(input)
  if (!parsed.success || selected.resume || selected.forkSession || selected.resumeSessionAt) {
    throw new Error('Invalid advisory launch.')
  }
  const remaining = parsed.data.deadlineAt - Date.now()
  if (remaining <= 0 || remaining > 300_000) {
    throw new Error('Invalid advisory deadline.')
  }
  const controller = new AbortController()
  const ended = () => controller.signal.aborted || Date.now() >= parsed.data.deadlineAt
  const server = createClaudeAdvisoryArtifactServer(parsed.data, sdk, controller.signal)
  let inputAdmitted = false
  const options: ClaudeSdk.Options = {
    model: selected.model,
    effort: selected.effort,
    sessionId: selected.sessionId,
    includePartialMessages: true,
    systemPrompt:
      'Answer the owner question using only the admitted artifact snapshots. Report evidence, uncertainty, and the next discriminating test. You have no operational authority.',
    tools: [],
    settingSources: [],
    plugins: [],
    supportedDialogKinds: [],
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
    strictMcpConfig: true,
    mcpServers: { orca_advisor: server },
    // shortcut: this loop ceiling needs native request-count qualification before enabling the role.
    maxTurns: parsed.data.maxModelCalls,
    extraArgs: { 'replay-user-messages': null },
    hooks: {
      PreToolUse: [
        {
          onFailure: 'block',
          timeout: 1,
          hooks: [
            async (event, _id, { signal }) => {
              const allowed =
                !ended() &&
                !signal.aborted &&
                event.hook_event_name === 'PreToolUse' &&
                TOOLS.has(event.tool_name) &&
                event.mcp_server?.name === 'orca_advisor' &&
                event.mcp_server.source === 'sdk'
              return {
                ...(!allowed ? { continue: false, stopReason: 'Advisor tool unavailable.' } : {}),
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: allowed ? 'allow' : 'deny'
                }
              }
            }
          ]
        }
      ]
    }
  }
  return {
    options,
    get remaining() {
      return Math.max(0, Math.min(remaining, parsed.data.deadlineAt - Date.now()))
    },
    beforeWrite: async (
      initialized: () => Promise<unknown>,
      beforeDispatch?: () => Promise<void>
    ) => {
      const result = await initialized()
      if (
        typeof result !== 'object' ||
        result === null ||
        !('hooks_applied' in result) ||
        result.hooks_applied !== true ||
        !('hook_on_failure_supported' in result) ||
        result.hook_on_failure_supported !== true
      ) {
        throw new Error('Advisor hooks unproven.')
      }
      await beforeDispatch?.()
      if (ended()) {
        throw new Error('Advisor access ended.')
      }
    },
    admitInput: () => {
      if (ended()) {
        throw new Error('Advisor access ended.')
      }
      if (inputAdmitted) {
        throw new Error('Advisor input already admitted.')
      }
      inputAdmitted = true
    },
    end: () => controller.abort()
  }
}
