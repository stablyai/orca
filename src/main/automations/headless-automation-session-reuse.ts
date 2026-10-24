import { randomUUID } from 'node:crypto'
import { AgentLaunchStructuredSessionRefusedError } from '../agent-launch/agent-launch-surface-factories'
import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import { hasExtraAgentArgs } from '../../shared/automation-extra-agent-args'
import { findReusableAutomationRun } from '../../shared/automation-session-reuse'
import { isNativeChatDefaultFor } from '../../shared/structured-native-chat-launch-route'
import { createStructuredAgentSessionId } from '../../shared/structured-agent-session-create'
import { createStructuredAgentSessionOperationId } from '../../shared/structured-agent-session-mutation'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { commitStructuredAgentSessionLaunchPrompt } from '../runtime/rpc/methods/agent-launch-structured-prompt'
import { deliverTerminalAgentLaunchPrompt } from '../runtime/rpc/methods/agent-launch-terminal-prompt'
import { createStructuredAgentSessionForWorktree } from '../runtime/rpc/methods/structured-agent-session-create'
import type { HeadlessAutomationAgentLaunch } from './headless-automation-agent-launch'
import { structuredAutomationRunHandle } from './runtime-structured-run-observer'

const STRUCTURED_SETUP_WAIT_TIMEOUT_MS = 60_000

type ReusableTarget =
  | { kind: 'terminal'; handle: string; previous: AutomationRun }
  | { kind: 'structured'; chatSessionId: string; fence: number; previous: AutomationRun }

/** The run's pane handle while that pane still holds the run's own PTY; null otherwise. */
export function runOwnHandle(runtime: OrcaRuntimeService, run: AutomationRun): string | null {
  const handle = run.terminalPaneKey
    ? runtime.getTerminalHandleForPaneKey(run.terminalPaneKey)
    : null
  return handle &&
    run.terminalPtyId &&
    runtime.getTerminalPtyIdForHandle(handle) === run.terminalPtyId
    ? handle
    : null
}

export function supportsStructuredAutomationRuntime(runtime: OrcaRuntimeService): boolean {
  return Boolean(
    runtime.ensureStructuredAgentSessionHost ||
    runtime.resolveStructuredAgentSessionCreateIntent ||
    getStructuredAgentSessionHost()
  )
}

export async function waitForStructuredAutomationSetup(
  runtime: Pick<OrcaRuntimeService, 'waitForSetupTerminalCompletion'>,
  receipt: Awaited<ReturnType<OrcaRuntimeService['createManagedWorktree']>>['setupReceipt']
): Promise<void> {
  if (
    !receipt ||
    receipt.startupPolicy !== 'wait-for-setup' ||
    receipt.state !== 'running' ||
    !receipt.terminalHandle ||
    typeof runtime.waitForSetupTerminalCompletion !== 'function'
  ) {
    return
  }
  const abort = new AbortController()
  const timer = setTimeout(
    () => abort.abort(new Error('structured_setup_wait_timeout')),
    STRUCTURED_SETUP_WAIT_TIMEOUT_MS
  )
  try {
    await runtime.waitForSetupTerminalCompletion(receipt.terminalHandle, abort.signal)
  } catch {
    // Setup completion is evidence, not a reason to strand a launch when the PTY disappears.
  } finally {
    clearTimeout(timer)
  }
}

export async function createHeadlessAutomationStructuredSession(args: {
  runtime: OrcaRuntimeService
  caller: { callerKey: string }
  worktreeId: string
  agent: StructuredAgentId
  withoutPrompt?: true
}): Promise<{
  sessionId: string
  handle: string
  fence: number
  tabId: string
}> {
  const sessionId = createStructuredAgentSessionId(args.agent, randomUUID)
  const created = await createStructuredAgentSessionForWorktree({
    runtime: args.runtime,
    ensureHost: async () => {
      await args.runtime.ensureStructuredAgentSessionHost?.()
      return requireInstalledStructuredHost()
    },
    caller: args.caller,
    envelope: {
      sessionId,
      clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
      expectedRuntimeFence: null,
      payloadFingerprint: ''
    },
    worktree: `id:${args.worktreeId}`,
    agent: args.agent,
    ...(args.withoutPrompt ? { atRest: true as const } : {}),
    activate: false
  })
  if (!created.ok) {
    throw new AgentLaunchStructuredSessionRefusedError(
      created.refusal.code,
      created.refusal.message
    )
  }
  const tabId = created.value.tabId ?? structuredAgentSessionTabId(created.value.sessionId)
  return {
    sessionId: created.value.sessionId,
    handle: structuredAgentSessionTabId(created.value.sessionId),
    fence: created.value.fence,
    tabId
  }
}

function isStructuredAutomationDefaultEnabled(
  runtime: OrcaRuntimeService,
  agent: Automation['agentId']
): boolean {
  if (typeof runtime.requireStore !== 'function') {
    return true
  }
  try {
    return isNativeChatDefaultFor(runtime.requireStore().getSettings(), agent)
  } catch {
    return false
  }
}

function requireInstalledStructuredHost(): StructuredAgentSessionHost {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new AgentLaunchStructuredSessionRefusedError(
      'structured_agent_session_unsupported',
      'Structured agent sessions are unavailable on this runtime.'
    )
  }
  return host
}

/** Null when no previous run's agent is idle in its own session or it did not take the prompt. */
export async function sendToReusableHeadlessAutomationSession(
  runtime: OrcaRuntimeService,
  request: {
    automation: Automation
    run: Pick<AutomationRun, 'id'>
    runs: readonly AutomationRun[]
    text: string
    worktreeId: string
  }
): Promise<HeadlessAutomationAgentLaunch | null> {
  const { automation, text, worktreeId } = request
  if (hasExtraAgentArgs(automation.extraAgentArgs)) {
    return null
  }
  const allowStructuredReuse =
    supportsStructuredAutomationRuntime(runtime) &&
    isStructuredAutomationDefaultEnabled(runtime, automation.agentId)
  const host = allowStructuredReuse ? getStructuredAgentSessionHost() : null
  const session = findReusableAutomationRun<ReusableTarget>({
    automationId: automation.id,
    agentId: automation.agentId,
    worktreeId,
    currentRunId: request.run.id,
    runs: request.runs,
    agentStatusForPane: (paneKey) =>
      runtime
        .getAgentStatusRowsForPane?.(paneKey)
        ?.filter((row) => !row.providerSessionOnly)
        .toSorted((left, right) => right.receivedAt - left.receivedAt)[0],
    liveSession: (previous) => {
      const handle = runOwnHandle(runtime, previous)
      return handle ? { kind: 'terminal', handle, previous } : null
    },
    structuredStatusForSession: (chatSessionId, previous) => {
      const summary = host?.readStatusSummary?.(chatSessionId)
      if (summary?.status) {
        return {
          state: summary.status === 'idle' ? 'done' : 'working',
          agentType: summary.agent
        }
      }
      const paneKey =
        previous.terminalPaneKey ??
        structuredAgentSessionPaneKey(structuredAgentSessionTabId(chatSessionId), chatSessionId)
      return runtime
        .getAgentStatusRowsForPane?.(paneKey)
        ?.filter((row) => !row.providerSessionOnly)
        .toSorted((left, right) => right.receivedAt - left.receivedAt)[0]
    },
    liveStructuredSession: (previous) => {
      const record = host?.deps.store.getRecord(previous.chatSessionId)
      if (!record || record.location.workspaceId !== worktreeId) {
        return null
      }
      return {
        kind: 'structured',
        chatSessionId: previous.chatSessionId,
        fence: record.lease.runtimeFence,
        previous
      }
    }
  })
  if (!session) {
    return null
  }
  if (session.kind === 'structured') {
    const messageId = await commitStructuredAgentSessionLaunchPrompt({
      host,
      caller: { callerKey: `automation:${request.run.id}` },
      sessionId: session.chatSessionId,
      fence: session.fence,
      text
    })
    if (!messageId) {
      return null
    }
    const shown = await runtime.showManagedWorktree(`id:${worktreeId}`)
    const tabId =
      session.previous.terminalSessionId ?? structuredAgentSessionTabId(session.chatSessionId)
    return {
      workspaceId: worktreeId,
      workspaceDisplayName: shown.displayName ?? null,
      sessionKind: 'structured',
      chatSessionId: session.chatSessionId,
      terminalHandle: structuredAutomationRunHandle(session.chatSessionId),
      terminalSessionId: tabId,
      terminalPaneKey:
        session.previous.terminalPaneKey ??
        structuredAgentSessionPaneKey(tabId, session.chatSessionId),
      terminalPtyId: null
    }
  }
  if (
    !(await deliverTerminalAgentLaunchPrompt({
      runtime,
      handle: session.handle,
      agent: automation.agentId,
      freshLaunch: false,
      text,
      // As a worker brief does: a Windows host cannot find the agent in front, only a shell.
      unprovableHost: 'write-unless-shell'
    }))
  ) {
    return null
  }
  const shown = await runtime.showManagedWorktree(`id:${worktreeId}`)
  return {
    workspaceId: worktreeId,
    workspaceDisplayName: shown.displayName ?? null,
    terminalHandle: session.handle,
    terminalSessionId: session.previous.terminalSessionId,
    terminalPaneKey: session.previous.terminalPaneKey,
    terminalPtyId: session.previous.terminalPtyId
  }
}
