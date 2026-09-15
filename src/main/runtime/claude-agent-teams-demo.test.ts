import { describe, expect, it, vi } from 'vitest'
import { ClaudeAgentTeamsService, type AgentTeamsTerminalApi } from './claude-agent-teams-service'

describe('Agent Team Demo - Agents A and B', () => {
  it('creates a team with two agents that report their names', async () => {
    const service = new ClaudeAgentTeamsService()

    // Create the team
    const launch = service.createLaunchEnv({
      leaderHandle: 'leader-handle',
      baseEnv: { PATH: '/usr/bin' },
      shimDir: '/tmp/orca-shim',
      shimBin: '/usr/bin/orca',
      paneShell: 'posix'
    })

    const teamId = launch.teamId
    const token = launch.token
    const leaderPane = launch.leaderPane

    // Track agent outputs
    const agents: { name: string; paneId: string; output: string }[] = []
    const liveHandles = new Set(['leader-handle'])
    let splitCount = 0

    const api: AgentTeamsTerminalApi = {
      splitTerminal: vi.fn(async (handle) => {
        if (!liveHandles.has(handle)) {
          throw new Error(`no live terminal for handle ${handle}`)
        }
        splitCount += 1
        const newHandle = `teammate-${splitCount}`
        const newPaneId = `%${splitCount + 1}`
        liveHandles.add(newHandle)

        // Determine which agent this is
        const agentName = splitCount === 1 ? 'A' : 'B'
        agents.push({
          name: agentName,
          paneId: newPaneId,
          output: `Agent ${agentName} started`
        })

        return { handle: newHandle, tabId: 'tab-1', paneRuntimeId: -1 }
      }),
      readTerminal: vi.fn(async (handle) => ({
        handle,
        status: 'running' as const,
        tail: ['running...'],
        truncated: false,
        nextCursor: null
      })),
      sendTerminal: vi.fn(async (handle, action) => ({
        handle,
        accepted: Boolean(action.text),
        bytesWritten: action.text?.length ?? 0
      })),
      focusTerminal: vi.fn(async (handle) => ({ handle, tabId: 'tab-1', worktreeId: 'wt-1' })),
      closeTerminal: vi.fn(async (handle) => {
        liveHandles.delete(handle)
        return { handle, tabId: 'tab-1', ptyKilled: true }
      }),
      showTerminal: vi.fn(async (handle) => ({
        handle,
        worktreeId: 'wt-1',
        worktreePath: '/tmp/wt',
        branch: 'main',
        tabId: 'tab-1',
        leafId: 'leaf-1',
        title: null,
        connected: true,
        writable: true,
        lastOutputAt: null,
        preview: '',
        paneRuntimeId: -1,
        ptyId: 'pty-1',
        rendererGraphEpoch: 1
      }))
    }

    // Create agent A
    const agentARequest = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv }, api)

    const agentASplit = await agentARequest([
      'split-window',
      '-t',
      leaderPane,
      '-h',
      '-P',
      '-F',
      '#{pane_id}'
    ])
    expect(agentASplit.ok).toBe(true)
    expect(agentASplit.exitCode).toBe(0)

    // Create agent B
    const agentBSplit = await agentARequest([
      'split-window',
      '-t',
      leaderPane,
      '-v',
      '-P',
      '-F',
      '#{pane_id}'
    ])
    expect(agentBSplit.ok).toBe(true)
    expect(agentBSplit.exitCode).toBe(0)

    // Verify team state
    expect(service.getActiveTeamCount()).toBe(1)
    expect(agents).toHaveLength(2)
    expect(agents[0].name).toBe('A')
    expect(agents[1].name).toBe('B')

    // Log agent names
    console.log('Agent Team Report:')
    agents.forEach((agent) => {
      console.log(`  - ${agent.name}: ${agent.output}`)
    })
  })
})
