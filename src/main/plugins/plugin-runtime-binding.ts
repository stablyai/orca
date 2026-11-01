import type { PluginEventName } from '../../shared/plugins/manifest/plugin-manifest'
import type { PluginAgentStatusChangedPayload } from '../../shared/plugins/events/plugin-events'
import { PLUGIN_WORKSPACE_TERMINAL_LIMIT } from '../../shared/plugins/workers/plugin-host-api'
import type { PluginRuntimeDelegate } from './workers/plugin-host-service-bindings'
import {
  pluginTerminalTitle,
  projectPluginWorkspaceContext,
  terminalForPane,
  type PluginAgentStatusRow,
  type PluginWorkspaceContext,
  type PluginWorkspaceTerminal
} from './workers/plugin-workspace-projection'

type PluginEvents = {
  emitEvent(event: PluginEventName, payload: unknown): void
  /** Whether any approved worker or open panel listens, so unheard events cost nothing. */
  wantsEvent(event: PluginEventName): boolean
}

type RuntimeDelegateSource = Omit<PluginRuntimeDelegate, 'listAgentStatuses'>

const WORKSPACE_CHANGE_DEBOUNCE_MS = 150

/** Main's runtime, plus the hook server's agent rows, as the plugin host's delegate. */
export function pluginRuntimeDelegate(
  runtime: RuntimeDelegateSource,
  agentStatuses: () => readonly PluginAgentStatusRow[]
): PluginRuntimeDelegate {
  return {
    resolveActiveWorktreeContext: () => runtime.resolveActiveWorktreeContext(),
    listTerminals: (...args) => runtime.listTerminals(...args),
    sendTerminal: (...args) => runtime.sendTerminal(...args),
    dispatchPluginNotification: (input) => runtime.dispatchPluginNotification(input),
    listAgentStatuses: agentStatuses
  }
}

async function listWorkspaceTerminals(
  delegate: PluginRuntimeDelegate,
  worktreeId: string
): Promise<PluginWorkspaceTerminal[]> {
  const { terminals } = await delegate.listTerminals(
    `id:${worktreeId}`,
    PLUGIN_WORKSPACE_TERMINAL_LIMIT,
    { includeVisualLayouts: false }
  )
  return terminals.map((terminal) => ({
    id: terminal.handle,
    title: pluginTerminalTitle(terminal),
    ...(terminal.tabId && terminal.leafId
      ? { paneKey: `${terminal.tabId}:${terminal.leafId}` }
      : {})
  }))
}

/**
 * `agent.status.changed` with the pane's `terminalId` and title, in arrival order. The lookup runs
 * only while some plugin listens.
 */
export function createPluginAgentStatusForwarder(
  delegate: PluginRuntimeDelegate,
  events: PluginEvents
): (payload: PluginAgentStatusChangedPayload, terminalHandle?: string) => void {
  let chain: Promise<void> = Promise.resolve()
  return (payload, terminalHandle) => {
    if (!events.wantsEvent('agent.status.changed')) {
      return
    }
    chain = chain.then(async () => {
      const { workspaceId } = payload
      const terminals = workspaceId
        ? await listWorkspaceTerminals(delegate, workspaceId).catch(() => [])
        : []
      const terminal = terminalForPane(terminals, { paneKey: payload.paneKey, terminalHandle })
      events.emitEvent('agent.status.changed', {
        ...payload,
        ...(terminal ? { terminalId: terminal.id } : {}),
        ...(terminal?.title ? { title: terminal.title } : {})
      })
    })
  }
}

/** The `workspace.changed` payload for the context as it is now. */
export async function readPluginWorkspaceChange(
  delegate: PluginRuntimeDelegate
): Promise<{ context: PluginWorkspaceContext }> {
  const context = await delegate.resolveActiveWorktreeContext().catch(() => null)
  const terminals = context
    ? await listWorkspaceTerminals(delegate, context.worktreeId).catch(() => [])
    : []
  return { context: projectPluginWorkspaceContext(context, terminals) }
}

/**
 * `workspace.changed`: after workspace session writes settle (focus moves, terminals open, close
 * or are renamed), re-read the context and emit when it differs from the last one sent.
 */
export function watchPluginWorkspaceContext(input: {
  delegate: PluginRuntimeDelegate
  events: PluginEvents
  onSessionWritten: (listener: () => void) => () => void
  delayMs?: number
}): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let last: string | null = null
  const check = async (): Promise<void> => {
    timer = null
    if (!input.events.wantsEvent('workspace.changed')) {
      last = null
      return
    }
    const change = await readPluginWorkspaceChange(input.delegate)
    const signature = JSON.stringify(change)
    if (signature !== last) {
      last = signature
      input.events.emitEvent('workspace.changed', change)
    }
  }
  const stop = input.onSessionWritten(() => {
    timer ??= setTimeout(() => void check(), input.delayMs ?? WORKSPACE_CHANGE_DEBOUNCE_MS)
  })
  return () => {
    stop()
    if (timer) {
      clearTimeout(timer)
    }
  }
}
