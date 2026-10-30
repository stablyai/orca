import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import { startRuntimeLocalWorktreeTerminals } from './runtime-local-worktree-terminal-startup'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1
}

const worktree: Worktree = {
  id: 'worktree-1',
  repoId: repo.id,
  path: '/worktree',
  head: 'abc',
  branch: 'feature',
  isBare: false,
  isMainWorktree: false,
  displayName: 'feature',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
}

type StartupArgs = Parameters<typeof startRuntimeLocalWorktreeTerminals>[0]

function createPorts() {
  const createTerminal = vi.fn<StartupArgs['ports']['createTerminal']>().mockResolvedValue({
    handle: 'term-1',
    worktreeId: worktree.id,
    title: null
  })
  const ports: StartupArgs['ports'] = {
    canSpawn: true,
    createTerminal,
    pasteDraft: vi.fn(),
    sendFollowup: vi.fn(),
    provision: vi.fn().mockResolvedValue({ setupSpawned: false, setupTerminalHandle: null }),
    activate: vi.fn()
  }
  return { createTerminal, ports }
}

const TAB_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const LEAF_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

async function startupTerminalOptions(startupPaneKey?: string) {
  const { createTerminal, ports } = createPorts()
  await startRuntimeLocalWorktreeTerminals({
    request: {
      repoSelector: `id:${repo.id}`,
      name: worktree.displayName,
      ...(startupPaneKey ? { startupPaneKey } : {})
    },
    repo,
    worktree,
    createdWithAgent: 'codex',
    startup: { command: 'codex' },
    ports
  })
  return createTerminal.mock.calls[0]?.[1] ?? {}
}

describe('startRuntimeLocalWorktreeTerminals reserved startup pane', () => {
  // The local, folder and remote creates each forward this separately, so nothing above them
  // catches the one that stops.
  it('creates the startup terminal under the pane the caller reserved', async () => {
    expect(await startupTerminalOptions(`${TAB_ID}:${LEAF_ID}`)).toMatchObject({
      tabId: TAB_ID,
      leafId: LEAF_ID
    })
  })

  it('leaves the pane to the runtime when none was reserved', async () => {
    const options = await startupTerminalOptions()
    expect(options).not.toHaveProperty('tabId')
    expect(options).not.toHaveProperty('leafId')
  })
})

describe('startRuntimeLocalWorktreeTerminals default shell seeding', () => {
  it.each([{}, { activate: true }, { runHooks: true }])(
    'preserves an explicit promised chat during setup (%j)',
    async (activation) => {
      const { ports } = createPorts()
      await startRuntimeLocalWorktreeTerminals({
        request: { repoSelector: repo.id, name: 'chat', ...activation },
        repo,
        worktree,
        setup: { runnerScriptPath: '/repo/setup.sh', envVars: {} },
        promisedAgentChat: true,
        ports
      })
      expect(ports.provision).toHaveBeenCalledWith(
        expect.objectContaining({ callerProvidesSurface: true })
      )
    }
  )

  it.each([false, true])(
    'passes the submitted setup-only choice to the host (%s)',
    async (setupOnly) => {
      const { ports } = createPorts()
      await startRuntimeLocalWorktreeTerminals({
        request: {
          repoSelector: `id:${repo.id}`,
          name: 'choice',
          setupOnly,
          awaitTerminalProvisioning: true
        },
        repo,
        worktree,
        setup: { runnerScriptPath: '/repo/setup.sh', envVars: {} },
        ports
      })
      expect(ports.provision).toHaveBeenCalledWith(expect.objectContaining({ setupOnly }))
    }
  )

  it.each([false, true])(
    'provisions a headless activated workspace without a viewer (setup=%s)',
    async (withSetup) => {
      const { ports } = createPorts()
      ports.provisionInBackground = () => true
      const setup = withSetup ? { runnerScriptPath: '/repo/setup.sh', envVars: {} } : undefined
      await startRuntimeLocalWorktreeTerminals({
        request: { repoSelector: `id:${repo.id}`, name: 'headless', activate: true },
        repo,
        worktree,
        setup,
        ports
      })
      expect(ports.provision).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreeId: worktree.id,
          hasStartupTerminal: false,
          surfaceOwner: false,
          ...(setup ? { setup } : {})
        })
      )
      expect(ports.createTerminal).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['Blank Terminal', undefined, 1],
    ['an agent', 'codex' as const, 0]
  ])('seeds a background shell for %s selection only', async (_label, agent, expectedCalls) => {
    const { createTerminal, ports } = createPorts()

    await startRuntimeLocalWorktreeTerminals({
      request: { repoSelector: `id:${repo.id}`, name: worktree.displayName },
      repo,
      worktree,
      ...(agent ? { createdWithAgent: agent } : {}),
      ports
    })

    expect(createTerminal).toHaveBeenCalledTimes(expectedCalls)
    if (expectedCalls > 0) {
      expect(createTerminal).toHaveBeenCalledWith(`id:${worktree.id}`, { surfaceOwner: false })
    }
  })

  it('hands failed startup and defaults to renderer before host provisioning', async () => {
    const { ports, createTerminal } = createPorts()
    createTerminal.mockRejectedValueOnce(new Error('pty unavailable'))
    const setup = { runnerScriptPath: '/repo/setup.sh', envVars: {} }
    const startup = { command: 'codex' }
    const defaultTabs = {
      runCommands: true,
      tabs: [{ title: 'Dev', command: 'pnpm dev' }]
    }
    await startRuntimeLocalWorktreeTerminals({
      request: {
        repoSelector: repo.id,
        name: 'recover',
        activate: true,
        awaitTerminalProvisioning: true
      },
      repo,
      worktree,
      startup,
      setup,
      defaultTabs,
      ports
    })
    expect(createTerminal).toHaveBeenCalledTimes(1)
    if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
      expect(ports.provision).not.toHaveBeenCalled()
      expect(ports.activate).toHaveBeenCalledWith(repo.id, worktree.id, startup, setup, defaultTabs)
      return
    }
    // Main keeps the agent's pane to show the failure and lays setup and default tabs out itself.
    expect(createTerminal).toHaveBeenCalledWith(
      `id:${worktree.id}`,
      expect.objectContaining({ command: 'codex', keepPaneOnStartFailure: true })
    )
    expect(ports.provision).toHaveBeenCalledWith(
      expect.objectContaining({
        setup,
        defaultTabs,
        primaryTerminalHandle: null,
        hasStartupTerminal: true
      })
    )
    expect(ports.activate).toHaveBeenCalledWith(
      repo.id,
      worktree.id,
      undefined,
      undefined,
      undefined
    )
  })

  it('does not treat agent attribution alone as a promised chat on activation', async () => {
    const { ports } = createPorts()
    await startRuntimeLocalWorktreeTerminals({
      request: { repoSelector: repo.id, name: 'attributed', activate: true },
      repo,
      worktree,
      createdWithAgent: 'codex',
      ports
    })
    expect(ports.activate).toHaveBeenCalledWith(
      repo.id,
      worktree.id,
      undefined,
      undefined,
      undefined
    )
  })
})

describe('startRuntimeLocalWorktreeTerminals held startup terminal (E9)', () => {
  it('names the stopped WSL distro in the warning, not the raw hold code', async () => {
    const { createTerminal, ports } = createPorts()
    createTerminal.mockRejectedValueOnce(new Error('terminal_held_wsl_distro_stopped:Ubuntu'))

    const result = await startRuntimeLocalWorktreeTerminals({
      request: { repoSelector: `id:${repo.id}`, name: worktree.displayName },
      repo,
      worktree,
      startup: { command: 'codex' },
      ports
    })

    expect(result.warning).toBe(
      "Failed to create the startup terminal for /worktree: The WSL distro Ubuntu is stopped, so Orca didn't start this terminal. Start the distro, then try again."
    )
    expect(result.warning).not.toContain('terminal_held_wsl_distro')
  })
})
