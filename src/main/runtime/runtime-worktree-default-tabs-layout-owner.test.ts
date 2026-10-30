import { describe, expect, it, vi } from 'vitest'
import type { CommandOf } from '../../shared/workspace-layout/workspace-layout-command-types'
import {
  provisionWorktreeTerminals,
  type WorktreeTerminalProvisioningHost
} from './runtime-worktree-terminal-provisioning'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const DEFAULT_TABS = {
  runCommands: true,
  tabs: [
    { title: 'Dev', command: 'pnpm dev', color: '#ff0000' },
    { title: 'Tests', command: 'pnpm test' },
    {}
  ]
}

function fakeHost() {
  const applied: CommandOf<'applyDefaultTabs'>['tabs'][] = []
  const createTerminal = vi.fn<WorktreeTerminalProvisioningHost['createTerminal']>(async () => ({
    handle: `term_${createTerminal.mock.calls.length}`
  }))
  const host: WorktreeTerminalProvisioningHost = {
    canSpawn: () => true,
    createTerminal,
    setTabTitle: vi.fn(async () => {}),
    setTabColor: vi.fn(async () => {}),
    applyDefaultTabs: vi.fn(async (_worktreeId, tabs) => {
      applied.push(tabs)
      return tabs
    }),
    getPtyId: () => undefined,
    recordSetupCompletionToken: vi.fn()
  }
  return { host, applied, createTerminal }
}

function provision(host: WorktreeTerminalProvisioningHost, startup: boolean) {
  return provisionWorktreeTerminals(host, {
    worktreeSelector: 'id:wt-1',
    worktreeId: 'wt-1',
    worktreePath: '/worktrees/wt-1',
    defaultTabs: DEFAULT_TABS,
    primaryTerminalHandle: startup ? 'term_agent' : null,
    hasStartupTerminal: startup,
    setupCommandPlatform: 'posix'
  })
}

describe('layout-owner build: a worktree’s default tabs, window or none', () => {
  it('writes every tab with its title and colour in one command, then starts each in its pane', async () => {
    const { host, applied, createTerminal } = fakeHost()
    await provision(host, false)

    expect(applied).toHaveLength(1)
    const [tabs] = applied
    expect(tabs!.map(({ title, color }) => ({ title, color }))).toEqual([
      { title: 'Dev', color: '#ff0000' },
      { title: 'Tests', color: undefined },
      { title: undefined, color: undefined }
    ])
    expect(createTerminal.mock.calls.map(([, options]) => options)).toEqual([
      { tabId: tabs![0]!.tabId, leafId: tabs![0]!.leafId, title: 'Dev', command: 'pnpm dev' },
      { tabId: tabs![1]!.tabId, leafId: tabs![1]!.leafId, title: 'Tests', command: 'pnpm test' },
      { tabId: tabs![2]!.tabId, leafId: tabs![2]!.leafId }
    ])
    expect(host.setTabTitle).not.toHaveBeenCalled()
    expect(host.setTabColor).not.toHaveBeenCalled()
  })

  it('dresses the agent’s tab as the first template and writes only the rest', async () => {
    const { host, applied } = fakeHost()
    await provision(host, true)

    expect(host.setTabTitle).toHaveBeenCalledWith('term_agent', 'Dev')
    expect(host.setTabColor).toHaveBeenCalledWith('term_agent', '#ff0000')
    expect(applied[0]!.map((tab) => tab.title)).toEqual(['Tests', undefined])
  })

  it('starts no default tab main refused, and seeds the worktree’s one shell as today', async () => {
    const { host, createTerminal } = fakeHost()
    vi.mocked(host.applyDefaultTabs!).mockResolvedValue(null)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await provision(host, false)
    expect(createTerminal.mock.calls.map(([, options]) => options)).toEqual([{}])
    warn.mockRestore()
  })

  it('starts none of the tabs when the workspace already had its default tabs', async () => {
    const { host, createTerminal } = fakeHost()
    vi.mocked(host.applyDefaultTabs!).mockResolvedValue([])
    await provision(host, true)
    expect(createTerminal).not.toHaveBeenCalled()
  })
})
