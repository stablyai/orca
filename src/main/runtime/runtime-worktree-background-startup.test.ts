import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { RuntimeStore } from './runtime-store-contract'
import { startRuntimeLocalWorktreeTerminals } from './runtime-local-worktree-terminal-startup'
import { createRuntimeRemoteManagedWorktree } from './runtime-remote-managed-worktree-create'
import { requestRuntimeRemoteWorktree } from './runtime-remote-worktree-create-request'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'

vi.mock('./runtime-remote-worktree-create-request', () => ({
  requestRuntimeRemoteWorktree: vi.fn()
}))

const repo: Repo = {
  id: 'repo',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '',
  addedAt: 0,
  connectionId: 'ssh-test'
}
const worktree: Worktree = {
  id: 'workspace',
  repoId: repo.id,
  path: '/repo/workspace',
  displayName: 'Workspace',
  head: 'abc',
  branch: 'workspace',
  isBare: false,
  isMainWorktree: false,
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}
const setup = { runnerScriptPath: '/repo/setup.sh', envVars: {} }
const defaultTabs = { tabs: [{ title: 'Logs', command: 'tail logs' }], runCommands: true }

function fixture(host: 'local' | 'remote', result: CreateWorktreeResult = { worktree }) {
  const ports = {
    markTrusted: vi.fn(async () => {}),
    createTerminal: vi.fn(async (_selector: string, _options: TerminalCreateOptions) => ({
      handle: 'terminal',
      worktreeId: worktree.id,
      title: null
    })),
    pasteDraft: vi.fn(),
    sendFollowup: vi.fn(),
    activate: vi.fn(),
    provision: vi.fn(async () => ({
      setupSpawned: Boolean(result.setup),
      setupTerminalHandle: 'setup'
    }))
  }
  vi.mocked(requestRuntimeRemoteWorktree).mockResolvedValue(result)
  const run = (request: Partial<RuntimeManagedWorktreeCreateArgs> = {}, canSpawn = true) => {
    const args = {
      repoSelector: repo.id,
      name: 'workspace',
      awaitTerminalProvisioning: true,
      ...request
    }
    return host === 'local'
      ? startRuntimeLocalWorktreeTerminals({
          request: args,
          repo,
          ...result,
          startup: args.startup,
          ports: { ...ports, canSpawn }
        })
      : createRuntimeRemoteManagedWorktree(repo, args, {
          ...ports,
          canSpawn: () => canSpawn,
          store: {} as RuntimeStore,
          invalidateResolvedWorktrees: vi.fn(),
          invalidateWorktreeScan: vi.fn(),
          notifyWorktreesChanged: vi.fn()
        })
  }
  return { ...ports, run }
}

beforeEach(() => vi.clearAllMocks())

describe.each(['local', 'remote'] as const)('%s background startup', (host) => {
  it.each([{ runHooks: true }, { activate: true }, { runHooks: true, activate: true }])(
    'does not select workspace despite %j',
    async (request) => {
      const f = fixture(host, { worktree, setup, defaultTabs })
      const result = await f.run({ ...request, startup: { command: 'agent', activate: false } })
      expect(f.activate).not.toHaveBeenCalled()
      expect(f.createTerminal).toHaveBeenCalledExactlyOnceWith(
        expect.any(String),
        expect.objectContaining({ command: 'agent', activate: false, surfaceOwner: false })
      )
      expect(f.provision).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          setup,
          defaultTabs,
          primaryTerminalHandle: 'terminal',
          hasStartupTerminal: true,
          surfaceOwner: false
        })
      )
      expect(
        'returnedSetup' in result
          ? result.returnedSetup
          : 'setup' in result
            ? result.setup
            : undefined
      ).toBeUndefined()
    }
  )

  it('awaits setup provisioning and preserves failed setup for renderer recovery', async () => {
    const f = fixture(host, { worktree, setup, defaultTabs })
    let finishProvisioning!: (result: {
      setupSpawned: boolean
      setupTerminalHandle: string
    }) => void
    f.provision.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishProvisioning = resolve
        })
    )
    let settled = false
    const creating = f
      .run({ startup: { command: 'agent', activate: false }, awaitTerminalProvisioning: true })
      .then((result) => {
        settled = true
        return result
      })
    await vi.waitFor(() => expect(f.provision).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    finishProvisioning({ setupSpawned: false, setupTerminalHandle: '' })
    const result = await creating
    expect(
      'returnedSetup' in result
        ? result.returnedSetup
        : 'setup' in result
          ? result.setup
          : undefined
    ).toEqual(setup)
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('preserves hook activation when the caller supplies no startup', async () => {
    const f = fixture(host, { worktree, setup, defaultTabs })
    await f.run({ runHooks: true })
    expect(f.activate).toHaveBeenCalledExactlyOnceWith(
      repo.id,
      worktree.id,
      setup,
      undefined,
      defaultTabs
    )
    expect(f.createTerminal).not.toHaveBeenCalled()
    expect(f.provision).not.toHaveBeenCalled()
  })

  it('preserves background startup through setup-agent sequencing', async () => {
    const f = fixture(host, { worktree, setup: { ...setup, waitForAgentStartup: true } })
    await f.run({ runHooks: true, startup: { command: 'agent', activate: false } })
    expect(f.activate).not.toHaveBeenCalled()
    expect(f.createTerminal).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      expect.objectContaining({ activate: false, surfaceOwner: false })
    )
    expect(f.provision).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        wrappedSetupCommand: expect.any(String),
        hasStartupTerminal: true,
        surfaceOwner: false
      })
    )
  })

  it.each([undefined, true])(
    'preserves hook activation with startup.activate=%s',
    async (activate) => {
      const f = fixture(host, { worktree, setup, defaultTabs })
      await f.run({ runHooks: true, startup: { command: 'agent', activate } })
      expect(f.activate).toHaveBeenCalledExactlyOnceWith(
        repo.id,
        worktree.id,
        undefined,
        undefined,
        undefined
      )
      expect(f.createTerminal.mock.calls[0]?.[1]).not.toHaveProperty('activate')
      expect(f.provision).toHaveBeenCalledTimes(1)
    }
  )

  it('does not activate after startup failure and still provisions setup once', async () => {
    const f = fixture(host, { worktree, setup, defaultTabs })
    f.createTerminal.mockRejectedValueOnce(new Error('connection unavailable'))
    const result = await f.run({ runHooks: true, startup: { command: 'agent', activate: false } })
    expect(f.activate).not.toHaveBeenCalled()
    expect(f.createTerminal).toHaveBeenCalledTimes(1)
    expect(f.provision).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        hasStartupTerminal: false,
        primaryTerminalHandle: null,
        surfaceOwner: false
      })
    )
    expect(result.warning).toContain('connection unavailable')
  })

  it('keeps setup recoverable without activating when no terminal provider is available', async () => {
    const f = fixture(host, { worktree, setup })
    const result = await f.run(
      { runHooks: true, startup: { command: 'agent', activate: false } },
      false
    )
    expect(f.activate).not.toHaveBeenCalled()
    expect(f.createTerminal).not.toHaveBeenCalled()
    expect(f.provision).not.toHaveBeenCalled()
    expect(
      'returnedSetup' in result
        ? result.returnedSetup
        : 'setup' in result
          ? result.setup
          : undefined
    ).toEqual(setup)
  })
})
