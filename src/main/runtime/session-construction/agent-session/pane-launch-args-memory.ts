// RA-11d: a pane's agent relaunched by the host (Restart of a pane with no agent session yet: the desktop
// stops the PTY, then the pane's reconnect asks the host to create the agent again) came back with the
// host's default args, dropping the ones the original launch used (`--model opus --effort high`). The host
// remembers the explicit agent args and launch preferences each placed launch used, and a later create
// for the same pane and agent that names none of its own reuses them. In memory: an orcad restart forgets,
// and the pane then gets the host defaults, as before.
import type { RuntimeCreateAgentSessionRequest } from '../../../../shared/agent-session/agent-session-host-authority'

type Remembered = Pick<RuntimeCreateAgentSessionRequest, 'agentArgs' | 'launchPreferences'>

const MAX_PANES = 500

export class PaneLaunchArgsMemory {
  private readonly byPane = new Map<string, Remembered>()

  private static key(request: RuntimeCreateAgentSessionRequest): string | null {
    const { tabId, leafId } = request.placement ?? {}
    return tabId && leafId ? JSON.stringify([request.worktree, tabId, leafId, request.agent]) : null
  }

  /** Records what an explicit placed launch used; returns the request a bare relaunch should run. */
  apply(request: RuntimeCreateAgentSessionRequest): RuntimeCreateAgentSessionRequest {
    const key = PaneLaunchArgsMemory.key(request)
    if (!key) {
      return request
    }
    const explicit = request.agentArgs !== undefined || request.launchPreferences !== undefined
    if (explicit) {
      this.byPane.delete(key)
      this.byPane.set(key, {
        ...(request.agentArgs !== undefined ? { agentArgs: request.agentArgs } : {}),
        ...(request.launchPreferences !== undefined
          ? { launchPreferences: request.launchPreferences }
          : {})
      })
      while (this.byPane.size > MAX_PANES) {
        const oldest = this.byPane.keys().next().value
        if (oldest === undefined) {
          break
        }
        this.byPane.delete(oldest)
      }
      return request
    }
    const remembered = this.byPane.get(key)
    return remembered ? { ...request, ...remembered } : request
  }
}
