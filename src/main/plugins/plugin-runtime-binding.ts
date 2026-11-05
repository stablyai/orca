import type { PluginEventName } from '../../shared/plugins/manifest/plugin-manifest'
import type { PluginAgentStatusChangedPayload } from '../../shared/plugins/events/plugin-events'
import type { PluginFocusedSurface } from '../../shared/plugins/events/plugin-focused-surface'
import { PLUGIN_WORKSPACE_TERMINAL_LIMIT } from '../../shared/plugins/workers/plugin-host-api'
import type { PluginRuntimeDelegate } from './workers/plugin-host-service-bindings'
import type { PluginService } from './plugin-service'
import { installPluginHookRunner } from './hooks/plugin-hook-participants'
import { installPluginResidentWorkerWarmer } from './workers/plugin-resident-worker'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { pluginRuntimeRpc } from './plugin-runtime-rpc'
import type { PluginRuntimeRpc } from './workers/plugin-host-workspace-method-bindings'
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

type RuntimeDelegateSource = Omit<PluginRuntimeDelegate, 'listAgentStatuses' | 'callRuntime'>

const WORKSPACE_CHANGE_DEBOUNCE_MS = 150

/** Main's runtime, plus the hook server's agent rows, as the plugin host's delegate. */
export function pluginRuntimeDelegate(
  runtime: RuntimeDelegateSource,
  agentStatuses: () => readonly PluginAgentStatusRow[],
  callRuntime?: PluginRuntimeRpc
): PluginRuntimeDelegate {
  return {
    ...(callRuntime ? { callRuntime } : {}),
    resolveActiveWorktreeContext: () => runtime.resolveActiveWorktreeContext(),
    listTerminals: (...args) => runtime.listTerminals(...args),
    sendTerminal: (...args) => runtime.sendTerminal(...args),
    dispatchPluginNotification: (input) => runtime.dispatchPluginNotification(input),
    listAgentStatuses: agentStatuses
  }
}

/** Binds the plugin host to main's runtime: its delegate, and the hooks Orca's own code runs. */
export function bindPluginRuntime(
  service: PluginService,
  runtime: OrcaRuntimeService,
  hookServer: { getStatusSnapshot(): readonly PluginAgentStatusRow[] },
  readFocusedSurface: () => PluginFocusedSurface
): PluginRuntimeDelegate {
  const statuses = () => hookServer.getStatusSnapshot()
  const delegate = {
    ...pluginRuntimeDelegate(runtime, statuses, pluginRuntimeRpc(runtime)),
    readFocusedSurface
  }
  service.setRuntimeDelegate(delegate)
  installPluginHookRunner(service, runtime)
  installPluginResidentWorkerWarmer(service)
  return delegate
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

/**
 * `ui.focus.changed`: after session writes settle or window focus moves, re-read the focused
 * surface and emit when it differs from the last one sent. `ui.readFocus` must read through the result.
 */
export function watchPluginUiFocus(input: {
  events: PluginEvents
  readFocusedSurface: () => PluginFocusedSurface
  onFocusInputChanged: (listener: () => void) => () => void
  delayMs?: number
}): { readFocusedSurface: () => PluginFocusedSurface; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  // Why track while nobody listens: a new subscriber reads `ui.readFocus` first, so only later changes are news.
  let last = JSON.stringify(input.readFocusedSurface())
  const check = (): void => {
    timer = null
    const focusedSurface = input.readFocusedSurface()
    const signature = JSON.stringify(focusedSurface)
    if (signature === last) {
      return
    }
    last = signature
    if (input.events.wantsEvent('ui.focus.changed')) {
      input.events.emitEvent('ui.focus.changed', { focusedSurface, receivedAt: Date.now() })
    }
  }
  const stop = input.onFocusInputChanged(() => {
    if (!input.events.wantsEvent('ui.focus.changed')) {
      // Why now, not debounced: a plugin may read focus and subscribe before the timer would run.
      last = JSON.stringify(input.readFocusedSurface())
      return
    }
    // Why debounce: blur then focus fire back to back when moving between Orca's own windows.
    timer ??= setTimeout(check, input.delayMs ?? WORKSPACE_CHANGE_DEBOUNCE_MS)
  })
  return {
    // Why flush first: a read inside the debounce must not get ahead of what listeners were sent.
    readFocusedSurface: () => {
      if (timer) {
        clearTimeout(timer)
        check()
      }
      return input.readFocusedSurface()
    },
    stop: () => {
      stop()
      if (timer) {
        clearTimeout(timer)
      }
    }
  }
}
