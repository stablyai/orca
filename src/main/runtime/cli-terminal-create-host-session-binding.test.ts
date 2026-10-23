/** A host-initiated create has no renderer session writer, so only its own
 *  durable binding and runtime ownership keep graph sync from pruning the tab
 *  out from under a live agent — including when a window is attached. */
import { describe, expect, it, vi } from 'vitest'
import { ClaudeAgentTeamsService } from './claude-agent-teams-service'
import * as launchPlan from './terminal/launch/agent-teams-launch-plan'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimePtyController } from './runtime-pty-controller-contract'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => ({ isDestroyed: () => false })) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

function createRuntimeWithAttachedWindow() {
  const runtime = new OrcaRuntimeService()
  vi.spyOn(
    runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
    },
    'resolveTerminalWorkspaceLaunchScope'
  ).mockResolvedValue({
    id: 'repo-1::/tmp/wt-cli',
    path: '/tmp/wt-cli',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  const spawn = vi
    .fn<NonNullable<RuntimePtyController['spawn']>>()
    .mockResolvedValue({ id: 'repo-1::/tmp/wt-cli@@a1b2c3d4' })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  } as never)
  runtime.attachWindow(1)
  return { runtime, spawn }
}

describe('host-initiated terminal creation under an attached window', () => {
  it('persists the host session binding at spawn', async () => {
    const { runtime, spawn } = createRuntimeWithAttachedWindow()

    await runtime.createTerminal('id:repo-1::/tmp/wt-cli', {})

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ persistHostSessionBinding: true }))
  })

  it('spawns hidden so main answers startup queries before any pane mounts', async () => {
    const { runtime, spawn } = createRuntimeWithAttachedWindow()

    await runtime.createTerminal('id:repo-1::/tmp/wt-cli', {})

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ initiallyHidden: true }))
  })

  it('marks the spawned PTY runtime-session-owned', async () => {
    const { runtime } = createRuntimeWithAttachedWindow()

    await runtime.createTerminal('id:repo-1::/tmp/wt-cli', {})

    const pty = (
      runtime as unknown as {
        ptysById: Map<string, { runtimeSessionOwned: boolean; connected: boolean }>
      }
    ).ptysById.get('repo-1::/tmp/wt-cli@@a1b2c3d4')
    expect(pty?.connected).toBe(true)
    expect(pty?.runtimeSessionOwned).toBe(true)
  })
  it.each(['cancelled', 'refused', 'accepted-then-presentation-error'])(
    'releases only this create allocation on %s with a reused handle',
    async (failure) => {
      const { runtime, spawn } = createRuntimeWithAttachedWindow()
      const teams = new ClaudeAgentTeamsService()
      const existing = teams.createLaunchEnv({
        leaderHandle: 'shared-handle',
        baseEnv: {},
        shimDir: '/shim',
        shimBin: '/orca'
      })
      Object.assign(runtime, { claudeAgentTeams: teams })
      const signal = new AbortController()
      const allocation = vi.spyOn(teams, 'createLaunchEnv')
      const release = vi.spyOn(teams, 'releaseTeam')
      const prepare = vi
        .spyOn(launchPlan, 'buildRuntimeAgentTeamsLaunchPlan')
        .mockImplementation(async (args) => {
          const env = args.createTeamEnv('/shim', '/orca')
          if (failure === 'cancelled') {
            signal.abort()
          }
          return { plan: { env, command: 'claude' }, effectiveLaunchConfig: args.launchConfig }
        })
      if (failure === 'refused') {
        spawn.mockRejectedValue(new Error('execution_owner_unavailable'))
      }
      if (failure === 'accepted-then-presentation-error') {
        runtime.setPtyController({
          spawn,
          write: () => true,
          kill: () => true,
          getForegroundProcess: async () => null,
          adoptStablePane: async (args) => {
            const operation = { mustExist: false }
            const result = await args.spawnFresh!(operation)
            args.onOutcome?.({ kind: 'committed', result }, operation)
            return null
          }
        })
        vi.spyOn(runtime, 'assertPtyDidNotExitBeforeRegistration').mockImplementation(() => {
          throw new Error('presentation failed')
        })
      }
      try {
        await expect(
          runtime.createTerminal('id:repo-1::/tmp/wt-cli', {
            command: 'claude',
            preAllocatedHandle: 'shared-handle',
            signal: signal.signal
          })
        ).rejects.toThrow()
        const allocatedId = allocation.mock.results[0]!.value.teamId
        expect(allocatedId).not.toBe(existing.teamId)
        expect([teams.getActiveTeamCount(), release.mock.calls]).toEqual(
          failure === 'accepted-then-presentation-error' ? [2, []] : [1, [[allocatedId]]]
        )
      } finally {
        prepare.mockRestore()
      }
    }
  )

  it('releases only the prepared allocation when a reused handle adopts a late winner', async () => {
    const { runtime, spawn } = createRuntimeWithAttachedWindow()
    const teams = new ClaudeAgentTeamsService()
    const existing = teams.createLaunchEnv({
      leaderHandle: 'shared-handle',
      baseEnv: {},
      shimDir: '/shim',
      shimBin: '/orca'
    })
    Object.assign(runtime, { claudeAgentTeams: teams })
    const allocation = vi.spyOn(teams, 'createLaunchEnv')
    const release = vi.spyOn(teams, 'releaseTeam')
    const prepare = vi
      .spyOn(launchPlan, 'buildRuntimeAgentTeamsLaunchPlan')
      .mockImplementation(async (args) => ({
        plan: { env: args.createTeamEnv('/shim', '/orca'), command: 'claude' },
        effectiveLaunchConfig: args.launchConfig
      }))
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      adoptStablePane: async (args) => {
        const operation = { mustExist: false }
        const result = { ...(await args.spawnFresh!(operation)), isReattach: true }
        expect(allocation).toHaveBeenCalledTimes(1)
        expect(teams.getActiveTeamCount()).toBe(2)
        expect(release).not.toHaveBeenCalled()
        args.onOutcome?.({ kind: 'adopted', result }, operation)
        return {
          result,
          owner: {
            handle: 'shared-handle',
            tabId: args.tabId,
            leafId: args.leafId,
            ptyId: result.id
          }
        }
      }
    })
    try {
      const result = await runtime.createTerminal('id:repo-1::/tmp/wt-cli', {
        command: 'claude',
        preAllocatedHandle: 'shared-handle'
      })
      const allocatedId = allocation.mock.results[0]!.value.teamId
      expect(allocatedId).not.toBe(existing.teamId)
      expect(spawn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          env: expect.objectContaining({ ORCA_AGENT_TEAMS_TEAM_ID: allocatedId })
        })
      )
      expect(result).toMatchObject({ ptyId: 'repo-1::/tmp/wt-cli@@a1b2c3d4', isReattach: true })
      expect([teams.getActiveTeamCount(), release.mock.calls]).toEqual([1, [[allocatedId]]])
      await expect(
        teams.handleTmuxCompat(
          { ...existing, envPane: existing.leaderPane, argv: ['list-panes', '-F', '#{pane_id}'] },
          runtime
        )
      ).resolves.toMatchObject({ ok: true, stdout: '%1\n', exitCode: 0 })
    } finally {
      prepare.mockRestore()
    }
  })
})
