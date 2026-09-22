import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'

const mocks = vi.hoisted(() => ({
  markAntigravityWorkspaceTrusted: vi.fn(),
  markCodexProjectTrusted: vi.fn(),
  markCopilotFolderTrusted: vi.fn(),
  markCursorWorkspaceTrusted: vi.fn(),
  detectRemoteAgents: vi.fn(),
  detectInstalledAgentsWithShellPathHydration: vi.fn()
}))

vi.mock('../agent-trust-presets', () => ({
  markAntigravityWorkspaceTrusted: mocks.markAntigravityWorkspaceTrusted,
  markCodexProjectTrusted: mocks.markCodexProjectTrusted,
  markCopilotFolderTrusted: mocks.markCopilotFolderTrusted,
  markCursorWorkspaceTrusted: mocks.markCursorWorkspaceTrusted
}))

vi.mock('../preflight/agent-detection', () => ({
  detectRemoteAgents: mocks.detectRemoteAgents,
  detectInstalledAgentsWithShellPathHydration: mocks.detectInstalledAgentsWithShellPathHydration
}))

import {
  buildWorktreeStartupForAgent,
  buildWorktreeStartupForDraft,
  markLocalWorktreeTrusted
} from './runtime-worktree-agent-startup'

function makeRepo(fields: Partial<Repo>): Repo {
  return {
    id: 'repo-1',
    name: 'repo',
    path: '/srv/repo',
    connectionId: null,
    executionHostId: null,
    ...fields
  } as Repo
}

const settings = {
  agentCmdOverrides: {},
  agentDefaultArgs: {},
  agentDefaultEnv: {},
  disabledTuiAgents: [],
  defaultTuiAgent: undefined,
  terminalWindowsShell: null
} as never

/** The launched CLI name is the whole decision: `orca` is the relay shim, `orca-ide` is local. */
function launchCliNameFor(repo: Repo): string {
  return buildWorktreeStartupForAgent({
    repo,
    settings,
    agent: 'claude-agent-teams',
    getLaunchPlatform: () => 'linux',
    toSessionOptions: () => undefined
  }).startup.command.split(' ')[0]!
}

describe('buildWorktreeStartupForAgent host resolution', () => {
  // Why two hosts: one SSH fixture passes even when the launch shape is resolved off another
  // host's row, which is the shape of the `ssh:m4air` -> openclaw leak.
  it('drops the Linux-only rename for both spellings of SSH ownership on two hosts', () => {
    expect(launchCliNameFor(makeRepo({ connectionId: 'm4air' }))).toBe('orca')
    expect(launchCliNameFor(makeRepo({ executionHostId: 'ssh:openclaw' }))).toBe('orca')
  })

  it('keeps the Linux rename for a local row carrying a stale connection', () => {
    expect(launchCliNameFor(makeRepo({ connectionId: 'm4air', executionHostId: 'local' }))).toBe(
      'orca-ide'
    )
  })

  it('drops the rename for a runtime host reaching a nested SSH target', () => {
    expect(
      launchCliNameFor(makeRepo({ connectionId: 'nested', executionHostId: 'runtime:vm-1' }))
    ).toBe('orca')
  })

  it('keeps the rename for a runtime host with no nested SSH target', () => {
    expect(launchCliNameFor(makeRepo({ executionHostId: 'runtime:vm-1' }))).toBe('orca-ide')
  })

  it('uses per-launch arguments and preserves launch telemetry', () => {
    const result = buildWorktreeStartupForAgent({
      repo: makeRepo({}),
      settings,
      agent: 'claude',
      agentArgs: '--model opus',
      launchSource: 'source_control_recovery',
      getLaunchPlatform: () => 'linux',
      toSessionOptions: () => undefined
    })

    expect(result.startup.command).toContain("'--model'")
    expect(result.startup.telemetry).toEqual({
      agent_kind: 'claude-code',
      launch_source: 'source_control_recovery',
      request_kind: 'new'
    })
  })
})

describe('buildWorktreeStartupForDraft agent detection', () => {
  it('probes the SSH host named only by executionHostId instead of this client', async () => {
    mocks.detectRemoteAgents.mockResolvedValueOnce(['claude'])
    mocks.detectInstalledAgentsWithShellPathHydration.mockResolvedValue([])

    const result = await buildWorktreeStartupForDraft({
      repo: makeRepo({ executionHostId: 'ssh:openclaw' }),
      settings,
      draft: 'ship it',
      getLaunchPlatform: () => 'linux'
    })

    expect(mocks.detectRemoteAgents).toHaveBeenCalledWith({ connectionId: 'openclaw' })
    expect(mocks.detectInstalledAgentsWithShellPathHydration).not.toHaveBeenCalled()
    expect(result?.agent).toBe('claude')
  })

  it('probes this client for a local row carrying a stale connection', async () => {
    mocks.detectRemoteAgents.mockClear()
    mocks.detectInstalledAgentsWithShellPathHydration.mockResolvedValueOnce(['claude'])

    const result = await buildWorktreeStartupForDraft({
      repo: makeRepo({ connectionId: 'm4air', executionHostId: 'local' }),
      settings,
      draft: 'ship it',
      getLaunchPlatform: () => 'linux'
    })

    expect(mocks.detectRemoteAgents).not.toHaveBeenCalled()
    expect(result?.agent).toBe('claude')
  })
})

describe('markLocalWorktreeTrusted', () => {
  it('waits for the Codex trust write before resolving', async () => {
    let finish!: () => void
    mocks.markCodexProjectTrusted.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    let settled = false
    const marking = markLocalWorktreeTrusted('codex', '/workspace/app').then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    finish()
    await marking
    expect(mocks.markCodexProjectTrusted).toHaveBeenCalledWith('/workspace/app')
  })

  it('contains a rejected Codex trust write', async () => {
    mocks.markCodexProjectTrusted.mockRejectedValueOnce(new Error('write failed'))

    await expect(markLocalWorktreeTrusted('codex', '/workspace/app')).resolves.toBeUndefined()
  })

  /**
   * Why this test exists: Orca has two trust dispatch chains — the renderer's
   * preflightAgentTrust (via the agentTrust:markTrusted IPC) and this main-process
   * one, which is the only path `orchestration worker-start` takes. Adding
   * `preflightTrust: 'antigravity'` to TUI_AGENT_CONFIG clears the `!preset` guard
   * here but matched none of the cursor/copilot/codex branches, so every supervised
   * agy worker still failed at agent_readiness with 'agent-trust-workspace' while
   * the renderer-side unit tests passed. Verified live: with the branch added, the
   * worktree is appended to ~/.gemini/antigravity-cli/settings.json and the dispatch
   * reaches worker_done.
   */
  it('writes the agy workspace trust artifact on the orchestration path', async () => {
    await markLocalWorktreeTrusted('antigravity', '/workspace/app')

    expect(mocks.markAntigravityWorkspaceTrusted).toHaveBeenCalledWith('/workspace/app')
  })

  it('contains a throwing agy trust write', async () => {
    mocks.markAntigravityWorkspaceTrusted.mockImplementationOnce(() => {
      throw new Error('write failed')
    })

    await expect(markLocalWorktreeTrusted('antigravity', '/workspace/app')).resolves.toBeUndefined()
  })
})
