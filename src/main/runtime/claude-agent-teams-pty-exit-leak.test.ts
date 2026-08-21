/**
 * Memory-leak regression: a Claude agent-team must be evicted when its leader PTY
 * goes away naturally, not only on explicit user-close.
 *
 * `ClaudeAgentTeamsService.createLaunchEnv` adds a team (with a nested panes Map)
 * per agent-team leader launch. The only eviction was `removeTeamForLeaderHandle`,
 * called solely from `MCodeRuntimeService.closeTerminal` (the explicit user-close IPC).
 * The natural-exit teardown paths — `onPtyExit` and `dropDisconnectedPtyRecord` —
 * tore down every other per-pty map but never evicted the team. teamId is a fresh
 * `team-${randomUUID()}`, so when a leader shell exits on its own (agent finishes,
 * process dies, renderer reload) the team + nested panes Map leaked permanently.
 */
import { describe, it, expect } from 'vitest'
import { MCodeRuntimeService } from './mcode-runtime'
import type { ClaudeAgentTeamsService } from './claude-agent-teams-service'

type RuntimeInternals = {
  claudeAgentTeams: ClaudeAgentTeamsService
  handleByPtyId: Map<string, string>
  dropDisconnectedPtyRecord: (ptyId: string) => void
}

function internals(runtime: MCodeRuntimeService): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

function registerTeam(runtime: MCodeRuntimeService, ptyId: string, leaderHandle: string): void {
  const { claudeAgentTeams, handleByPtyId } = internals(runtime)
  claudeAgentTeams.createLaunchEnv({
    leaderHandle,
    baseEnv: {},
    shimDir: '/tmp/mcode-shim',
    shimBin: 'mcode'
  })
  // onPtyExit / dropDisconnectedPtyRecord resolve the leader handle via this map.
  handleByPtyId.set(ptyId, leaderHandle)
}

describe('ClaudeAgentTeams eviction on natural PTY exit (leak regression)', () => {
  it('evicts the team when its leader PTY exits naturally (onPtyExit)', () => {
    const runtime = new MCodeRuntimeService()
    registerTeam(runtime, 'pty-leader', 'handle-leader')
    expect(internals(runtime).claudeAgentTeams.getActiveTeamCount()).toBe(1)

    runtime.onPtyExit('pty-leader', 0)

    expect(internals(runtime).claudeAgentTeams.getActiveTeamCount()).toBe(0)
  })

  it('evicts the team when the disconnected PTY record is pruned', () => {
    const runtime = new MCodeRuntimeService()
    registerTeam(runtime, 'pty-leader', 'handle-leader')
    expect(internals(runtime).claudeAgentTeams.getActiveTeamCount()).toBe(1)

    internals(runtime).dropDisconnectedPtyRecord('pty-leader')

    expect(internals(runtime).claudeAgentTeams.getActiveTeamCount()).toBe(0)
  })

  it('does not accumulate teams across many natural leader exits', () => {
    const runtime = new MCodeRuntimeService()
    for (let i = 0; i < 100; i++) {
      registerTeam(runtime, `pty-${i}`, `handle-${i}`)
      runtime.onPtyExit(`pty-${i}`, 0)
    }
    expect(internals(runtime).claudeAgentTeams.getActiveTeamCount()).toBe(0)
  })

  it('leaves a concurrently-launched team intact when only one leader exits', () => {
    const runtime = new MCodeRuntimeService()
    registerTeam(runtime, 'pty-a', 'handle-a')
    registerTeam(runtime, 'pty-b', 'handle-b')
    expect(internals(runtime).claudeAgentTeams.getActiveTeamCount()).toBe(2)

    runtime.onPtyExit('pty-a', 0)

    // Only team A is evicted; team B (still live) remains.
    expect(internals(runtime).claudeAgentTeams.getActiveTeamCount()).toBe(1)
  })

  it('is a no-op for a PTY that never launched a team', () => {
    const runtime = new MCodeRuntimeService()
    const { handleByPtyId } = internals(runtime)
    handleByPtyId.set('pty-plain', 'handle-plain') // a normal terminal, no team
    expect(internals(runtime).claudeAgentTeams.getActiveTeamCount()).toBe(0)

    runtime.onPtyExit('pty-plain', 0)

    expect(internals(runtime).claudeAgentTeams.getActiveTeamCount()).toBe(0)
  })
})
