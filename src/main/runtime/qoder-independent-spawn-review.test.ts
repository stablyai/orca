import './rpc/unused-default-rpc-methods.test-fixture'
import { beforeEach, expect, it, vi } from 'vitest'
import filesystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAgentResumeStartupPlan } from '../../shared/tui-agent-startup'
import { buildAiVaultResumeShellCommand } from '../../shared/ai-vault-resume-command'

await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
const {
  store,
  TEST_WORKTREE_PATH,
  TEST_FOLDER_WORKSPACE_KEY,
  createFolderWorkspaceRuntimeStore,
  makeFolderWorkspace,
  makeFolderProjectGroup
} = await import('./orca-runtime-test-fixtures.spec')
const { detectAgentCommandsOnHost } = await import('../preflight/agent-detection')
beforeEach(() =>
  vi
    .mocked(detectAgentCommandsOnHost)
    .mockReset()
    .mockResolvedValue(new Set(['qodercli']))
)

it.each([
  ['modern-only', ['qoder'], 'qoder'],
  ['legacy-only', ['qodercli'], 'qodercli'],
  ['both', ['qoder', 'qodercli'], 'qodercli']
] as const)(
  'fresh managed start reaches the production spawn boundary: %s',
  async (_, found, selected) => {
    vi.mocked(detectAgentCommandsOnHost).mockResolvedValueOnce(new Set(found))
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-independent-start' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({ ...store.getSettings(), disabledTuiAgents: [], agentCmdOverrides: {} })
    })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      startupAgent: 'qoder',
      agentArgs: null,
      launchSource: 'orchestration',
      startupPrompt: 'qodercli remains prompt text'
    })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        launchAgent: 'qoder',
        command: `${selected} --prompt-interactive 'qodercli remains prompt text'`
      })
    )
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]?.[0].telemetry).toEqual({
      agent_kind: 'qoder',
      launch_source: 'orchestration',
      request_kind: 'new'
    })
  }
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

it('selects the installed command for a mobile Qoder history resume at creation', async () => {
  vi.mocked(detectAgentCommandsOnHost).mockResolvedValueOnce(new Set(['qoder']))
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-mobile-qoder-resume' })
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const plan = buildAgentResumeStartupPlan({
    agent: 'qoder',
    providerSession: { key: 'session_id', id: 'same-qoder-session' },
    cmdOverrides: {},
    platform: 'darwin'
  })
  if (!plan) {
    throw new Error('Missing Qoder resume plan')
  }
  const launch = {
    command: buildAiVaultResumeShellCommand({
      resumeCommand: plan.launchCommand,
      cwd: TEST_WORKTREE_PATH,
      platform: 'darwin'
    }),
    launchAgent: plan.agent,
    launchConfig: plan.launchConfig
  }
  await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
    command: launch.command,
    launchAgent: launch.launchAgent,
    launchConfig: launch.launchConfig
  })
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(spawn).toHaveBeenCalledWith(
    expect.objectContaining({
      command: launch.command.replace(/qodercli(?=\s)/, 'qoder'),
      launchAgent: 'qoder'
    })
  )
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

it('caller-owned explicit executable survives production resume without discovery', async () => {
  const detect = vi.mocked(detectAgentCommandsOnHost)
  detect.mockClear()
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-independent-explicit' })
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
    launchAgent: 'qoder',
    command: '/caller/qodercli --resume original-id'
  })
  expect(spawn).toHaveBeenCalledWith(
    expect.objectContaining({ command: '/caller/qodercli --resume original-id' })
  )
  expect(detect).not.toHaveBeenCalled()
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(spawn.mock.calls[0]?.[0].telemetry).toBeUndefined()
})

it.each([
  ['bare', 'qodercli'],
  ['resume', 'qodercli --resume original-id']
] as const)('does not falsely attribute a %s command as a fresh start', async (_, command) => {
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-independent-unattributed' })
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
    command,
    agentArgs: null,
    launchSource: 'orchestration',
    ...(command.includes('--resume') ? { launchAgent: 'qoder' as const } : {})
  })
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(spawn.mock.calls[0]?.[0].command).toBe(command)
  expect(spawn.mock.calls[0]?.[0].telemetry).toBeUndefined()
})

it.each(['offline', 'legacy-identity'])(
  'refuses a Qoder command-bearing create with unverifiable inventory: %s',
  async (state) => {
    const { TEST_WORKTREE_ID } = await import('./orca-runtime-test-fixtures.spec')
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
  const { TEST_WORKTREE_ID } = await import('./orca-runtime-test-fixtures.spec')
  vi.useFakeTimers()
  try {
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const live: {
      id: string
      cwd: string
      title: string
      worktreeId: string
      terminalHandle: string
    }[] = []
    const spawn = vi.fn(async (args: { preAllocatedHandle?: string }) => {
      const id = `qoder-${live.length + 1}`
      live.push({
        id,
        cwd: TEST_WORKTREE_PATH,
        title: 'Qoder',
        worktreeId: TEST_WORKTREE_ID,
        terminalHandle: args.preAllocatedHandle ?? ''
      })
      return { id }
    })
    runtime.setPtyController({
      spawn,
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
