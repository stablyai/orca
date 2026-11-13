import type * as ClaudeSdk from '@anthropic-ai/claude-agent-sdk'
import { readClaudeAdvisoryBinding } from './claude-advisory-binding'
import { createClaudeAdvisoryObservation } from './claude-advisory-observation'
import type { AgentSessionAdvisoryObservation } from '../../../shared/agent-session/agent-session-advisory-receipt'
import { agentSessionAdvisoryPolicySchema } from '../../../shared/agent-session/agent-session-advisory-policy'
import { createClaudeAdvisoryArtifactServer } from './claude-advisory-artifacts'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionAdvisoryReporter } from '../../../shared/agent-session/agent-session-advisory-report'
import type { ClaudeStreamJsonConnection } from '../claude-stream-json-connection-types'
import { claudeUnwrittenUserMessageError } from '../sdk-transport/claude-agent-sdk-user-message-queue'

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
  >,
  publish?: AgentSessionAdvisoryReporter,
  observe?: (value: AgentSessionAdvisoryObservation) => void
) {
  const parsed = agentSessionAdvisoryPolicySchema.safeParse(input)
  if (!parsed.success || selected.resume || selected.forkSession || selected.resumeSessionAt) {
    throw new Error('Invalid advisory launch.')
  }
  if (
    parsed.data.schema === 2 &&
    (selected.model !== parsed.data.binding.model || selected.effort !== parsed.data.binding.effort)
  ) {
    throw new Error('Invalid advisory launch binding.')
  }
  const remaining = parsed.data.deadlineAt - Date.now()
  if (remaining <= 0 || remaining > 300_000) {
    throw new Error('Invalid advisory deadline.')
  }
  const controller = new AbortController()
  const ended = () => controller.signal.aborted || Date.now() >= parsed.data.deadlineAt
  let close: ClaudeStreamJsonConnection['close'] | undefined
  let onFault: ((error: Error) => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = (reason?: Error) => {
    if (reason) {
      observation.invalidate()
    }
    controller.abort()
    const stopped = close?.({ grace: 'brief' })
    if (reason) {
      onFault?.(reason)
    }
    void stopped
      ?.then((gone) => {
        if (!gone) {
          onFault?.(new Error('Advisor process exit unproven.'))
        }
      })
      .catch((error: unknown) =>
        onFault?.(error instanceof Error ? error : new Error('Advisor stop failed.'))
      )
  }
  const observation = createClaudeAdvisoryObservation(
    parsed.data,
    (value) => observe?.(value),
    stop
  )
  const server = createClaudeAdvisoryArtifactServer(
    parsed.data,
    sdk,
    controller.signal,
    publish &&
      (async (report) => {
        if (!close) {
          throw new Error('Advisor report unavailable.')
        }
        try {
          await publish(report)
          observation.reported()
          if (parsed.data.schema === 1) {
            stop()
          }
        } catch (error) {
          observation.invalidate()
          stop()
          throw error
        }
      })
  )
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
                (TOOLS.has(event.tool_name) ||
                  Boolean(publish && event.tool_name === 'mcp__orca_advisor__report_advice')) &&
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
    bindClose: (
      ownedClose: ClaudeStreamJsonConnection['close'],
      fault?: (error: Error) => void
    ) => {
      close = ownedClose
      onFault = fault
      timer = setTimeout(
        () => stop(new Error('Advisor deadline reached.')),
        Math.max(0, Math.min(remaining, parsed.data.deadlineAt - Date.now()))
      )
      timer.unref()
    },
    beforeWrite: async (
      initialized: () => Promise<unknown>,
      beforeDispatch?: () => Promise<void>,
      readBinding?: () => Promise<unknown>
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
      if (parsed.data.schema === 2) {
        let observed
        try {
          observed = readBinding && readClaudeAdvisoryBinding(await readBinding())
        } catch {
          observed = null
        }
        observation.binding(observed || null, true)
        if (
          !observed ||
          observed.accountFingerprint !== parsed.data.binding.accountFingerprint ||
          observed.model !== parsed.data.binding.model ||
          observed.effort !== parsed.data.binding.effort
        ) {
          throw new Error('Advisor native binding unproven.')
        }
      }
      await beforeDispatch?.()
      if (ended()) {
        throw new Error('Advisor access ended.')
      }
      observation.admitted()
    },
    admitInput: () => {
      if (ended()) {
        return claudeUnwrittenUserMessageError(new Error('Advisor access ended.'))
      }
      if (inputAdmitted) {
        return claudeUnwrittenUserMessageError(new Error('Advisor input already admitted.'))
      }
      inputAdmitted = true
      return null
    },
    end: () => {
      controller.abort()
      clearTimeout(timer)
    },
    observeMessage: observation.message,
    observeClosure: (
      root: ClaudeStreamJsonConnection['exitVerdict']['root'],
      tree: ClaudeStreamJsonConnection['exitVerdict']['tree']
    ) =>
      observation.closure({
        root: root === 'exited' ? 'exited' : 'unverifiable',
        tree: tree === 'exited' ? 'exited' : 'unverifiable',
        observedAt: Date.now()
      })
  }
}
