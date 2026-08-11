import type { AgentLaunchPreferences } from '../../../shared/agent-session-host-authority'
import type { RoomHarnessAgent } from '../../../shared/rooms'
import type { RoomHarnessBinding, RoomHarnessRuntime } from './harness-adapter-types'
import { roomHarnessBindingFromTerminal } from './participant-harness-binding'
import { resolveRoomTerminalRestorationSurface } from './room-terminal-restoration-surface'

/** Nobody watches a room pane, so interactive CLI nudges deadlock deliveries. */
export const ROOM_AGENT_EXTRA_ARGS: Partial<Record<RoomHarnessAgent, string>> = {
  codex: '-c notice.hide_rate_limit_model_nudge=true -c check_for_update_on_startup=false'
}

export async function ensureLiveRoomHarnessSession(args: {
  agent: RoomHarnessAgent
  runtime: RoomHarnessRuntime
  binding: RoomHarnessBinding
  preferences?: AgentLaunchPreferences
  surface?: ReturnType<typeof resolveRoomTerminalRestorationSurface>
}): Promise<RoomHarnessBinding> {
  const { agent, runtime, binding, preferences } = args
  const providerSession = binding.providerSession
  if (!providerSession) {
    throw new Error('room_agent_session_identity_required')
  }
  const surface =
    args.surface ??
    resolveRoomTerminalRestorationSurface(runtime, binding.worktreeId, binding.paneKey)
  const previousIncarnation = runtime.getTerminalProcessIncarnation(binding.terminalHandle)
  // Bounded by the realistic number of stale claim holders per thread.
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await runtime.ensureAgentSession({
      kind: 'explicit',
      worktree: `id:${binding.worktreeId}`,
      agent,
      providerSession,
      extraAgentArgs: ROOM_AGENT_EXTRA_ARGS[agent],
      launchPreferences: preferences,
      presentation: 'background',
      ...(surface.placement ? { placement: surface.placement } : {}),
      surfaceOwner: false,
      persistHostSessionBinding: surface.persisted
    })
    if (result.disposition !== 'adopted') {
      return roomHarnessBindingFromTerminal(
        binding.worktreeId,
        result.terminal,
        providerSession,
        'created'
      )
    }
    const incarnation = runtime.getTerminalProcessIncarnation(result.terminal.handle)
    const replaced =
      result.terminal.handle !== binding.terminalHandle ||
      (previousIncarnation !== null && incarnation !== null && incarnation !== previousIncarnation)
    if (
      replaced &&
      !(await runtime.waitForTerminalAgentInputReady(result.terminal.handle, agent))
    ) {
      await runtime.closeTerminal(result.terminal.handle, { force: true }).catch(() => {})
      continue
    }
    const status = await runtime
      .getTerminalAgentStatus(result.terminal.handle, { confirmForeground: true })
      .catch(() => null)
    if (status?.isRunningAgent) {
      return roomHarnessBindingFromTerminal(
        binding.worktreeId,
        result.terminal,
        providerSession,
        'adopted'
      )
    }
    await runtime.closeTerminal(result.terminal.handle, { force: true }).catch(() => {})
  }
  throw new Error('room_agent_session_unrecoverable')
}
