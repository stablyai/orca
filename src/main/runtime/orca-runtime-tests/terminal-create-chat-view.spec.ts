import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, join, mkdtemp, tmpdir } from '../orca-runtime-test-mocks.spec'
import {
  TEST_FOLDER_WORKSPACE_KEY,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  createFolderWorkspaceRuntimeStore,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  store
} from '../orca-runtime-test-fixtures.spec'
import { createMobileCreateTestNotifier } from '../orca-runtime-test-scenario-builders.spec'
import type { TerminalCreateOptions } from '../runtime-terminal-contracts'
import { eraseRpcMethods } from '../rpc/core'
import { TERMINAL_METHODS } from '../rpc/methods/terminal'
import { TerminalCreateParams } from '../../../shared/rpc-contract/terminal-unary-params'

type SpawnCall = { command?: string; launchAgent?: string }

const WORKTREE = `id:${TEST_WORKTREE_ID}`
const CLAUDE_CHAT = { viewMode: 'chat', commandAgent: 'claude' } as const

function headlessRuntime(runtimeStore: typeof store = store) {
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-chat-view' })
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  return { runtime, spawn }
}

async function spawnFor(
  selector: string,
  opts: TerminalCreateOptions,
  runtimeStore?: typeof store
): Promise<SpawnCall | undefined> {
  const { runtime, spawn } = headlessRuntime(runtimeStore)
  await runtime.createTerminal(selector, opts)
  return spawn.mock.calls[0]?.[0]
}

describe('terminal create in chat view', () => {
  it('runs a bare launcher exactly as the same create without chat view', async () => {
    const plain = await spawnFor(WORKTREE, { command: 'claude' })
    const chat = await spawnFor(WORKTREE, { command: 'claude', ...CLAUDE_CHAT })

    expect(plain?.launchAgent).toBe('claude')
    expect(chat?.command).toBe(plain?.command)
    expect(chat?.launchAgent).toBe('claude')
  })

  it('keeps a wrapper command as typed and gives it the named agent', async () => {
    const command = "zsh -lc 'exec claude'"
    const plain = await spawnFor(WORKTREE, { command })
    const chat = await spawnFor(WORKTREE, { command, ...CLAUDE_CHAT })

    expect(plain?.launchAgent).toBeUndefined()
    expect(chat).toMatchObject({ command, launchAgent: 'claude' })
  })

  it('names the agent in a folder workspace, where no launcher is recognized', async () => {
    const folderPath = await mkdtemp(join(tmpdir(), 'orca-chat-view-folder-'))
    const folderStore = createFolderWorkspaceRuntimeStore(
      makeFolderWorkspace({ folderPath }),
      makeFolderProjectGroup({ parentPath: folderPath })
    )

    const chat = await spawnFor(
      TEST_FOLDER_WORKSPACE_KEY,
      { command: 'claude', ...CLAUDE_CHAT },
      folderStore
    )

    expect(chat).toMatchObject({ command: 'claude', launchAgent: 'claude' })
  })

  it('refuses a named agent that contradicts the launcher before spawning', async () => {
    const { runtime, spawn } = headlessRuntime()

    await expect(
      runtime.createTerminal(WORKTREE, { command: 'codex', ...CLAUDE_CHAT })
    ).rejects.toThrow(/contradicts codex/)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('refuses an agent whose transcript an SSH workspace cannot serve', async () => {
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const { runtime, spawn } = headlessRuntime({
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
    })

    await expect(
      runtime.createTerminal(WORKTREE, {
        command: 'opencode',
        viewMode: 'chat',
        commandAgent: 'opencode'
      })
    ).rejects.toThrow(/over SSH/)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('carries the view and agent from a terminal.create call to the new tab', async () => {
    const { runtime, spawn } = headlessRuntime()
    const method = eraseRpcMethods(TERMINAL_METHODS).find(({ name }) => name === 'terminal.create')
    if (!method) {
      throw new Error('terminal.create method missing')
    }
    const call = (params: Record<string, unknown>) =>
      method.handler(TerminalCreateParams.parse(params), { runtime }, vi.fn())

    await expect(
      call({ command: './start-agent.sh', viewMode: 'chat', commandAgent: 'claude' })
    ).rejects.toThrow(/needs a worktree/)
    expect(spawn).not.toHaveBeenCalled()

    await call({
      worktree: WORKTREE,
      command: './start-agent.sh',
      viewMode: 'chat',
      commandAgent: 'claude'
    })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ command: './start-agent.sh', launchAgent: 'claude' })
    )
    const { tabs } = await runtime.listMobileSessionTabs(WORKTREE)
    expect(tabs).toContainEqual(
      expect.objectContaining({ viewMode: 'chat', launchAgent: 'claude' })
    )
  })

  it('shows the tab as a chat in the window and to paired clients', async () => {
    const { runtime } = headlessRuntime()
    const notifier = createMobileCreateTestNotifier(vi.fn())
    runtime.setNotifier(notifier)

    const created = await runtime.createTerminal(WORKTREE, {
      command: './start-agent.sh',
      ...CLAUDE_CHAT
    })

    expect(notifier.revealTerminalSession).toHaveBeenCalledWith(
      TEST_WORKTREE_ID,
      expect.objectContaining({ launchAgent: 'claude', viewMode: 'chat' })
    )
    const { tabs } = await runtime.listMobileSessionTabs(WORKTREE)
    expect(tabs.find((tab) => tab.id.startsWith(created.tabId!))).toMatchObject({
      viewMode: 'chat',
      launchAgent: 'claude'
    })
  })
})
