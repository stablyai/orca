import { createHash } from 'node:crypto'
import type {
  BoundContext,
  CanvasAgentContextStore
} from '../../../shared/canvas-agent-context-store'
import type { OrcaRuntimeService } from '../orca-runtime'

export type CanvasMember = BoundContext
export const canvasMemberEpoch = (member: CanvasMember): string =>
  JSON.stringify([member.ptyId, member.identity?.launchTokenHash, member.identity?.sessionId])

export class CanvasMessageMembership {
  constructor(
    readonly contexts: CanvasAgentContextStore,
    private readonly runtime: OrcaRuntimeService
  ) {}

  members(canvasId: string): readonly CanvasMember[] {
    return this.contexts.snapshot().get(canvasId)?.bindings ?? []
  }

  actor(canvasId: string, paneKey: string, launchToken: string): CanvasMember {
    const members = this.members(canvasId).filter((member) => member.paneKey === paneKey)
    if (members.length !== 1) {
      throw new Error('The canvas agent is missing or ambiguous.')
    }
    const member = members[0]
    if (
      createHash('sha256').update(launchToken).digest('hex') !== member.identity?.launchTokenHash
    ) {
      throw new Error('The caller does not own this canvas session.')
    }
    this.live(member)
    return member
  }

  live(member: CanvasMember): string {
    const settings = this.runtime.getClientSettings()
    if (!settings.agentStatusHooksEnabled || settings.disabledTuiAgents.includes(member.provider)) {
      throw new Error('Agent hooks must be enabled for canvas messaging.')
    }
    const terminal = this.runtime.resolveTerminalPane(member.paneKey, member.worktreeId)
    const leaf = this.runtime.resolveLiveLeafForHandle(terminal.handle)
    const authority = this.runtime.getOrchestrationDispatchAuthority(terminal.handle)
    const observed = this.contexts.identity(member.paneKey, member.provider, member.worktreeId)
    if (terminal.executionHostId !== 'local') {
      throw new Error('Canvas messaging is unavailable on this execution host.')
    }
    if (
      terminal.ptyId !== member.ptyId ||
      leaf?.ptyId !== member.ptyId ||
      !member.identity?.sessionId ||
      !observed ||
      observed.sessionId !== member.identity.sessionId ||
      observed.launchTokenHash !== member.identity.launchTokenHash ||
      (authority?.launchTokenHash && authority.launchTokenHash !== member.identity.launchTokenHash)
    ) {
      throw new Error('The agent session is unverifiable or changed. Reconnect this agent.')
    }
    return terminal.handle
  }

  connected(canvasId: string, source: string, target: string): [CanvasMember, CanvasMember] {
    const members = this.members(canvasId)
    const from = members.find((member) => member.nodeId === source)
    const to = members.find((member) => member.nodeId === target)
    if (
      !from ||
      !to ||
      source === target ||
      !from.peers?.includes(target) ||
      !to.peers?.includes(source)
    ) {
      throw new Error('These agents are no longer connected.')
    }
    return [from, to]
  }
}
