import type { PtyProcessInfo, PtyProviderBufferSnapshot } from '../../types'
import type { HerdrAgentStatus, HerdrHostTransport, HerdrPane } from './herdr-runtime-contract'
import { unwrapHerdrResponse } from './herdr-runtime-contract'
import type {
  HerdrPaneMoveDestination,
  HerdrPaneMoveResult,
  HerdrPaneProcessInfo,
  HerdrPaneSwapOptions,
  HerdrPtyBinding
} from './herdr-pty-types'

export type HerdrPaneDetails = HerdrPane & {
  cwd?: string
  foreground_cwd?: string
  label?: string
  title?: string
  terminal_title?: string
}

async function getHerdrPane(
  transport: HerdrHostTransport,
  binding: HerdrPtyBinding
): Promise<HerdrPaneDetails> {
  return unwrapHerdrResponse<{ pane: HerdrPaneDetails }>(
    await transport.request(binding.sessionName, 'pane.get', { pane_id: binding.paneId })
  ).pane
}

async function getHerdrProcessInfo(
  transport: HerdrHostTransport,
  binding: HerdrPtyBinding
): Promise<HerdrPaneProcessInfo> {
  return unwrapHerdrResponse<{ process_info: HerdrPaneProcessInfo }>(
    await transport.request(binding.sessionName, 'pane.process_info', {
      pane_id: binding.paneId
    })
  ).process_info
}

export async function getHerdrBindingCwd(binding: HerdrPtyBinding): Promise<string> {
  const pane = await getHerdrPane(binding.transport, binding)
  return pane.foreground_cwd ?? pane.cwd ?? binding.cwd
}

export async function clearHerdrBindingBuffer(binding: HerdrPtyBinding): Promise<void> {
  binding.snapshot = ''
}

export async function herdrBindingHasChildProcesses(binding: HerdrPtyBinding): Promise<boolean> {
  return (await getHerdrProcessInfo(binding.transport, binding)).foreground_processes.length > 0
}

export async function getHerdrBindingForegroundProcess(
  binding: HerdrPtyBinding
): Promise<string | null> {
  return (
    (await getHerdrProcessInfo(binding.transport, binding)).foreground_processes.at(-1)?.name ??
    null
  )
}

export async function getHerdrBindingProcessInfo(
  binding: HerdrPtyBinding
): Promise<PtyProcessInfo> {
  const pane = await getHerdrPane(binding.transport, binding)
  return {
    id: binding.id,
    terminalHandle: `term_${binding.paneId}`,
    incarnationId: binding.incarnationId,
    cwd: pane.foreground_cwd ?? pane.cwd ?? binding.cwd,
    title: pane.title ?? pane.terminal_title ?? pane.label ?? 'Herdr',
    worktreeId: binding.identity.worktreeId
  }
}

export async function getHerdrBindingBufferSnapshot(
  binding: HerdrPtyBinding,
  scrollbackRows: number | undefined,
  source: 'visible' | 'recent' | 'recent_unwrapped' | 'detection' = 'recent_unwrapped'
): Promise<PtyProviderBufferSnapshot> {
  const result = unwrapHerdrResponse<{
    read: { text: string; revision: number; truncated?: boolean }
  }>(
    await binding.transport.request(binding.sessionName, 'pane.read', {
      pane_id: binding.paneId,
      source,
      lines: scrollbackRows,
      format: 'ansi',
      strip_ansi: false
    })
  )
  return {
    data: result.read.text,
    cols: binding.cols,
    rows: binding.rows,
    cwd: binding.cwd,
    seq: result.read.revision,
    source: 'headless'
  }
}

export type HerdrBindingAgentState = {
  agent: string | null
  agent_status: HerdrAgentStatus
  interactive_ready?: boolean
  launch_pending?: boolean
  state_labels?: Record<string, string>
  display_agent?: string | null
  name?: string | null
  pane_id: string
}

export async function getHerdrBindingAgentState(
  binding: HerdrPtyBinding
): Promise<HerdrBindingAgentState> {
  const result = unwrapHerdrResponse<HerdrBindingAgentState>(
    await binding.transport.request(binding.sessionName, 'agent.get', {
      target: binding.paneId
    })
  )
  return {
    agent: result.agent ?? null,
    agent_status: result.agent_status ?? 'unknown',
    interactive_ready: result.interactive_ready,
    launch_pending: result.launch_pending,
    state_labels: result.state_labels,
    display_agent: result.display_agent,
    name: result.name,
    pane_id: binding.paneId
  }
}

export async function waitForHerdrBindingAgent(
  binding: HerdrPtyBinding,
  until: HerdrAgentStatus[],
  timeoutMs: number
): Promise<HerdrBindingAgentState> {
  const result = unwrapHerdrResponse<{ agent: HerdrBindingAgentState }>(
    await binding.transport.request(binding.sessionName, 'agent.wait', {
      target: binding.paneId,
      until,
      timeout_ms: timeoutMs
    })
  )
  return {
    agent: result.agent.agent ?? null,
    agent_status: result.agent.agent_status ?? 'unknown',
    pane_id: binding.paneId
  }
}

export async function reportHerdrBindingAgent(
  binding: HerdrPtyBinding,
  agent: string,
  state: HerdrAgentStatus,
  message?: string
): Promise<void> {
  unwrapHerdrResponse(
    await binding.transport.request(binding.sessionName, 'pane.report_agent', {
      pane_id: binding.paneId,
      source: 'orca',
      agent,
      state,
      message
    })
  )
}

const notificationDebounce = new Map<string, number>()
const NOTIFICATION_DEBOUNCE_MS = 30_000

export async function maybeNotifyBlocked(
  binding: HerdrPtyBinding,
  agent: string,
  state: HerdrAgentStatus
): Promise<void> {
  if (state !== 'blocked') {
    return
  }
  const now = Date.now()
  pruneNotificationDebounce(now)
  const key = `${binding.sessionName}:${binding.paneId}`
  const last = notificationDebounce.get(key) ?? 0
  if (now - last < NOTIFICATION_DEBOUNCE_MS) {
    return
  }
  notificationDebounce.set(key, now)
  try {
    await binding.transport.request(binding.sessionName, 'notification.show', {
      title: 'Agent blocked',
      body: `Agent ${agent} is blocked`,
      position: 'bottom-right',
      sound: 'done'
    })
  } catch {}
}

// Drop entries whose debounce window has already elapsed so the map stays
// bounded by panes notified in the last window instead of growing forever.
function pruneNotificationDebounce(now: number): void {
  for (const [key, last] of notificationDebounce) {
    if (now - last >= NOTIFICATION_DEBOUNCE_MS) {
      notificationDebounce.delete(key)
    }
  }
}

export async function zoomHerdrBinding(
  binding: HerdrPtyBinding,
  mode: 'toggle' | 'on' | 'off' = 'toggle',
  paneId?: string
): Promise<{ changed: boolean; zoomed: boolean; focused_pane_id: string }> {
  const result = unwrapHerdrResponse<{
    changed: boolean
    zoomed: boolean
    focused_pane_id: string
  }>(
    await binding.transport.request(binding.sessionName, 'pane.zoom', {
      pane_id: paneId ?? binding.paneId,
      mode
    })
  )
  return result
}

export async function swapHerdrBinding(
  binding: HerdrPtyBinding,
  params: HerdrPaneSwapOptions
): Promise<{
  changed: boolean
  source_pane_id: string
  target_pane_id: string | null
  focused_pane_id: string
}> {
  const result = unwrapHerdrResponse<{
    changed: boolean
    source_pane_id: string
    target_pane_id: string | null
    focused_pane_id: string
  }>(
    await binding.transport.request(binding.sessionName, 'pane.swap', {
      pane_id: binding.paneId,
      direction: params.direction,
      source_pane_id: params.source_pane_id,
      target_pane_id: params.target_pane_id
    })
  )
  return result
}

export async function moveHerdrBinding(
  binding: HerdrPtyBinding,
  params: {
    destination: HerdrPaneMoveDestination
    focus?: boolean
  }
): Promise<HerdrPaneMoveResult> {
  const result = unwrapHerdrResponse<HerdrPaneMoveResult>(
    await binding.transport.request(binding.sessionName, 'pane.move', {
      pane_id: binding.paneId,
      destination: params.destination,
      focus: params.focus
    })
  )
  return result
}

export async function resizeHerdrBinding(
  binding: HerdrPtyBinding,
  direction: 'left' | 'right' | 'up' | 'down',
  amount?: number,
  paneId?: string
): Promise<{ changed: boolean; pane_id: string; focused_pane_id: string }> {
  const result = unwrapHerdrResponse<{
    changed: boolean
    pane_id: string
    focused_pane_id: string
  }>(
    await binding.transport.request(binding.sessionName, 'pane.resize', {
      pane_id: paneId ?? binding.paneId,
      direction,
      amount
    })
  )
  return result
}
