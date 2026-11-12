import { beforeEach, expect, it, vi } from 'vitest'

import filesystem from 'node:fs/promises'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

await import('../../orca-runtime-tests/runtime-test-module-registration.spec')
await import('../../orca-runtime-tests/orca-runtime-test-lifecycle.spec')
await import('../../orca-runtime-tests/runtime-test-module-registration.spec')
const { OrcaRuntimeService } = await import('../../orca-runtime')
const {
  store,
  TEST_WORKTREE_PATH,
  TEST_FOLDER_WORKSPACE_KEY,
  createFolderWorkspaceRuntimeStore,
  makeFolderWorkspace,
  makeFolderProjectGroup
} = await import('../../orca-runtime-tests/orca-runtime-test-fixtures.spec')
const { committingSpawn } = await import('../../orca-runtime-tests/bind-first-pane.test-fixture')
const { detectAgentCommandsOnHost } = await import('../../../preflight/agent-command-detection')
beforeEach(() =>
  vi
    .mocked(detectAgentCommandsOnHost)
    .mockReset()
    .mockResolvedValue(new Set(['qodercli']))
)

it('a modern-only repo-less folder start reaches the same production spawn boundary', async () => {
  vi.mocked(detectAgentCommandsOnHost).mockResolvedValueOnce(new Set(['qoder']))
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-independent-folder' })
  const createTempDirectory = filesystem.mkdtemp
  const guard = vi.spyOn(filesystem, 'mkdtemp').mockImplementation((prefix, options) => {
    // CI has no .context parent; reject that prerequisite even on a developer checkout.
    expect(String(prefix)).not.toContain('.context')
    return createTempDirectory(prefix, options)
  })
  let folderPath: string | undefined
  try {
    folderPath = await filesystem.mkdtemp(join(tmpdir(), 'qoder-independent-folder-'))
    const folderStore = createFolderWorkspaceRuntimeStore(
      makeFolderWorkspace({ folderPath }),
      makeFolderProjectGroup({ parentPath: folderPath })
    )
    const runtime = new OrcaRuntimeService({
      ...folderStore,
      getSettings: () => ({ ...store.getSettings(), disabledTuiAgents: [], agentCmdOverrides: {} })
    })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`id:${TEST_FOLDER_WORKSPACE_KEY}`, {
      startupAgent: 'qoder',
      agentArgs: null
    })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ launchAgent: 'qoder', command: 'qoder' })
    )
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]?.[0].cwd).toBe(folderPath)
    expect(spawn.mock.calls[0]?.[0].telemetry).toEqual({
      agent_kind: 'qoder',
      launch_source: 'unknown',
      request_kind: 'new'
    })
    expect((await filesystem.stat(folderPath)).isDirectory()).toBe(true)
    await expect(filesystem.stat(join(folderPath, '.git'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  } finally {
    guard.mockRestore()
    if (folderPath) {
      await filesystem.rm(folderPath, { recursive: true, force: true })
    }
  }
})

it('host discovery refusal prevents any production spawn', async () => {
  vi.mocked(detectAgentCommandsOnHost).mockRejectedValueOnce(
    new Error('execution host unavailable')
  )
  const spawn = vi.fn()
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  await expect(
    runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      launchAgent: 'qoder',
      command: 'qodercli --resume original-id'
    })
  ).rejects.toThrow('execution host unavailable')
  expect(spawn).not.toHaveBeenCalled()
})

it.each(['offline', 'legacy-identity'])(
  'refuses a Qoder command-bearing create with unverifiable inventory: %s',
  async (state) => {
    const { TEST_WORKTREE_ID } =
      await import('../../orca-runtime-tests/orca-runtime-test-fixtures.spec')
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const spawn = vi.fn()
    const kill = vi.fn()
    runtime.setPtyController({
      spawn,
      kill,
      write: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => {
        if (state === 'offline') {
          throw new Error('host offline')
        }
        return [
          {
            id: 'older-live-pty',
            cwd: TEST_WORKTREE_PATH,
            title: 'shell',
            worktreeId: TEST_WORKTREE_ID
          }
        ]
      }
    })
    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        command: "qodercli '--resume' 'same-session'",
        launchAgent: 'qoder',
        clientNavigationId: 'paired-phone',
        clientMutationId: 'same-resume',
        select: false,
        activate: false
      })
    ).rejects.toThrow('runtime_unavailable')
    expect(spawn).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  }
)

it('reconciles after the reply-cache expires and isolates deliberate forks and paired callers', async () => {
  const { TEST_WORKTREE_ID } =
    await import('../../orca-runtime-tests/orca-runtime-test-fixtures.spec')
  vi.useFakeTimers()
  try {
    // Copy the fixture store so main-owned bindings cannot leak into shared tests.
    const runtime = new OrcaRuntimeService({ ...store })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const live: {
      id: string
      cwd: string
      title: string
      worktreeId: string
      terminalHandle: string
    }[] = []
    const spawn = vi.fn(
      async (args: {
        preAllocatedHandle?: string
        worktreeId?: string
        tabId?: string
        leafId?: string
      }) => {
        const id = `qoder-${live.length + 1}`
        live.push({
          id,
          cwd: TEST_WORKTREE_PATH,
          title: 'Qoder',
          worktreeId: TEST_WORKTREE_ID,
          terminalHandle: args.preAllocatedHandle ?? ''
        })
        return { id }
      }
    )
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      listProcesses: async () => live,
      kill: vi.fn(),
      write: () => true,
      getForegroundProcess: async () => null
    })
    const resume = {
      command: "qodercli '--resume' 'same-session'",
      launchAgent: 'qoder' as const,
      clientNavigationId: 'phone-a',
      clientMutationId: 'resume-a',
      select: false,
      activate: false
    }
    const first = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, resume)
    await vi.advanceTimersByTimeAsync(61_000)
    const retry = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, resume)
    expect(retry.tab.id).toBe(first.tab.id)
    expect(retry.tab.ptyId).toBe(first.tab.ptyId)
    expect(spawn).toHaveBeenCalledTimes(1)
    const fork = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      ...resume,
      clientMutationId: 'resume-b'
    })
    const otherPhone = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      ...resume,
      clientNavigationId: 'phone-b'
    })
    expect(spawn).toHaveBeenCalledTimes(3)
    expect(new Set([first.tab.id, fork.tab.id, otherPhone.tab.id]).size).toBe(3)
  } finally {
    vi.useRealTimers()
  }
})
