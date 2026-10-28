/** Natural PTY exit/disconnect must evict leader teams too; explicit close was once the only cleanup. */
import { describe, it, expect } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { ClaudeAgentTeamsService } from './claude-agent-teams-service'

export function registerClaudeAgentTeamsPtyExitLeakTests(): void {
  type RuntimeInternals = {
    claudeAgentTeams: ClaudeAgentTeamsService
    handleByPtyId: Map<string, string>
    dropDisconnectedPtyRecord: (ptyId: string) => void
  }

  function internals(runtime: OrcaRuntimeService): RuntimeInternals {
    return runtime as unknown as RuntimeInternals
  }

  function registerTeam(runtime: OrcaRuntimeService, ptyId: string, leaderHandle: string): void {
    const { claudeAgentTeams, handleByPtyId } = internals(runtime)
    claudeAgentTeams.createLaunchEnv({
      leaderHandle,
      baseEnv: {},
      shimDir: '/tmp/orca-shim',
      shimBin: 'orca'
    })
    handleByPtyId.set(ptyId, leaderHandle)
  }

  describe('ClaudeAgentTeams eviction on natural PTY exit (leak regression)', () => {
    it('evicts the team when its leader PTY exits naturally (onPtyExit)', () => {
      const runtime = new OrcaRuntimeService()
      registerTeam(runtime, 'pty-leader', 'handle-leader')
      expect(internals(runtime).claudeAgentTeams.getActiveTeamCount()).toBe(1)

      runtime.onPtyExit('pty-leader', 0)

      expect(internals(runtime).claudeAgentTeams.getActiveTeamCount()).toBe(0)
    })

    it('evicts the team when the disconnected PTY record is pruned', () => {
      const runtime = new OrcaRuntimeService()
      registerTeam(runtime, 'pty-leader', 'handle-leader')
      expect(internals(runtime).claudeAgentTeams.getActiveTeamCount()).toBe(1)

      internals(runtime).dropDisconnectedPtyRecord('pty-leader')

      expect(internals(runtime).claudeAgentTeams.getActiveTeamCount()).toBe(0)
    })

    it('does not accumulate teams across many natural leader exits', () => {
      const runtime = new OrcaRuntimeService()
      for (let i = 0; i < 100; i++) {
        registerTeam(runtime, `pty-${i}`, `handle-${i}`)
        runtime.onPtyExit(`pty-${i}`, 0)
      }
      expect(internals(runtime).claudeAgentTeams.getActiveTeamCount()).toBe(0)
    })

    it('leaves a concurrently-launched team intact when only one leader exits', () => {
      const runtime = new OrcaRuntimeService()
      registerTeam(runtime, 'pty-a', 'handle-a')
      registerTeam(runtime, 'pty-b', 'handle-b')
      expect(internals(runtime).claudeAgentTeams.getActiveTeamCount()).toBe(2)

      runtime.onPtyExit('pty-a', 0)

      expect(internals(runtime).claudeAgentTeams.getActiveTeamCount()).toBe(1)
    })

    it('is a no-op for a PTY that never launched a team', () => {
      const runtime = new OrcaRuntimeService()
      const { handleByPtyId } = internals(runtime)
      handleByPtyId.set('pty-plain', 'handle-plain')
      expect(internals(runtime).claudeAgentTeams.getActiveTeamCount()).toBe(0)

      runtime.onPtyExit('pty-plain', 0)

      expect(internals(runtime).claudeAgentTeams.getActiveTeamCount()).toBe(0)
    })
  })
}
