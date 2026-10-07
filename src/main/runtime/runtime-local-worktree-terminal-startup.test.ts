import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import { startRuntimeLocalWorktreeTerminals } from './runtime-local-worktree-terminal-startup'

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
})

describe('startRuntimeLocalWorktreeTerminals reports when it asks for the startup agent', () => {
  /** A startup create that fails; `afterDispatch` says whether its spawn request had left. */
  async function failedStartup(afterDispatch: boolean) {
    const { createTerminal, ports } = createPorts()
    createTerminal.mockImplementationOnce(async (_selector, options) => {
      if (afterDispatch) {
        options.onPtySpawnDispatched?.()
      }
      throw new Error('reply lost')
    })
    const onStartupAgentRequested = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await startRuntimeLocalWorktreeTerminals({
        request: { repoSelector: `id:${repo.id}`, name: 'task', onStartupAgentRequested },
        repo,
        worktree,
        createdWithAgent: 'codex',
        startup: { command: 'codex' },
        ports
      })
      return { result, onStartupAgentRequested }
    } finally {
      warn.mockRestore()
    }
  }

  it('reports a startup spawn whose request left, even though it then failed', async () => {
    const { result, onStartupAgentRequested } = await failedStartup(true)
    expect(result.didSpawnStartup).toBe(false)
    expect(onStartupAgentRequested).toHaveBeenCalledOnce()
  })

  it('reports nothing for a startup spawn that failed before its request left', async () => {
    const { onStartupAgentRequested } = await failedStartup(false)
    expect(onStartupAgentRequested).not.toHaveBeenCalled()
  })

  it('reports a startup handed to the window, which starts it out of sight', async () => {
    const { ports } = createPorts()
    const onStartupAgentRequested = vi.fn()
    await startRuntimeLocalWorktreeTerminals({
      request: {
        repoSelector: `id:${repo.id}`,
        name: 'task',
        activate: true,
        onStartupAgentRequested
      },
      repo,
      worktree,
      createdWithAgent: 'codex',
      startup: { command: 'codex' },
      ports: { ...ports, canSpawn: false }
    })
    expect(ports.activate).toHaveBeenCalledWith(
      repo.id,
      worktree.id,
      undefined,
      { command: 'codex' },
      undefined
    )
    expect(onStartupAgentRequested).toHaveBeenCalledOnce()
  })
})
