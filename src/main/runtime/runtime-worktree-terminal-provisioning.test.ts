import { describe, expect, it, vi } from 'vitest'
import {
  provisionWorktreeTerminals,
  type WorktreeTerminalProvisioningHost
} from './runtime-worktree-terminal-provisioning'

const DEFAULT_TABS = {
  runCommands: true,
  tabs: [
    { title: 'Dev', command: 'pnpm dev', color: '#ff0000' },
    { title: 'Tests', command: 'pnpm test', color: '#00ff00' }
  ]
}

function fakeHost() {
  let created = 0
  return {
    canSpawn: () => true,
    createTerminal: vi.fn(async () => {
      created += 1
      return { handle: `term_${created}` }
    }),
    setTabTitle: vi.fn(async (_handle: string, _title: string) => {}),
    setTabColor: vi.fn(async (_handle: string, _color: string) => {}),
    getPtyId: () => undefined,
    recordSetupCompletionToken: vi.fn()
  } satisfies Partial<Record<keyof WorktreeTerminalProvisioningHost, unknown>>
}

function provision(host: ReturnType<typeof fakeHost>, startup: boolean) {
  return provisionWorktreeTerminals(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every host member provisioning reaches for default tabs with no setup.
    host as unknown as WorktreeTerminalProvisioningHost,
    {
      worktreeSelector: 'id:wt-1',
      worktreeId: 'wt-1',
      worktreePath: '/worktrees/wt-1',
      defaultTabs: DEFAULT_TABS,
      primaryTerminalHandle: startup ? 'term_agent' : null,
      hasStartupTerminal: startup,
      setupCommandPlatform: 'posix'
    }
  )
}

describe('default tabs beside the agent a create started', () => {
  it('makes the agent the first default tab, as the window lays it out', async () => {
    const host = fakeHost()
    await provision(host, true)

    expect(host.setTabTitle).toHaveBeenCalledWith('term_agent', 'Dev')
    expect(host.setTabColor).toHaveBeenCalledWith('term_agent', '#ff0000')
    // The first template's command never runs beside the agent; only the rest are created.
    expect(host.createTerminal).toHaveBeenCalledTimes(1)
    expect(host.createTerminal).toHaveBeenCalledWith('id:wt-1', {
      title: 'Tests',
      command: 'pnpm test'
    })
  })

  it('dresses every created default tab the same way', async () => {
    const host = fakeHost()
    await provision(host, false)

    expect(host.createTerminal).toHaveBeenCalledTimes(2)
    expect(host.setTabTitle.mock.calls).toEqual([
      ['term_1', 'Dev'],
      ['term_2', 'Tests']
    ])
    expect(host.setTabColor.mock.calls).toEqual([
      ['term_1', '#ff0000'],
      ['term_2', '#00ff00']
    ])
  })

  it('still colors the tab and creates the rest when titling fails', async () => {
    const host = fakeHost()
    host.setTabTitle.mockRejectedValue(new Error('terminal_tab_unresolved'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(provision(host, true)).resolves.toEqual({
      setupSpawned: false,
      setupTerminalHandle: null
    })

    expect(host.setTabColor).toHaveBeenCalledWith('term_agent', '#ff0000')
    expect(host.createTerminal).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      '[worktree-create] Failed to title a default tab for wt-1:',
      expect.any(Error)
    )
    warn.mockRestore()
  })
})

const setup = { runnerScriptPath: '/repo/.orca/setup.sh', envVars: {} }

function createHost(): {
  host: WorktreeTerminalProvisioningHost
  titles: () => (string | undefined)[]
} {
  const createTerminal = vi.fn<WorktreeTerminalProvisioningHost['createTerminal']>(async () => ({
    handle: `term-${createTerminal.mock.calls.length}`
  }))
  return {
    host: {
      canSpawn: () => true,
      createTerminal,
      setTabTitle: vi.fn(async () => {}),
      setTabColor: vi.fn(async () => {}),
      getPtyId: () => undefined,
      recordSetupCompletionToken: vi.fn()
    },
    titles: () => createTerminal.mock.calls.map(([, options]) => options.title)
  }
}

function provisionWithSetup(
  host: WorktreeTerminalProvisioningHost,
  withSetup = true,
  setupOnly?: boolean,
  defaultTabs?: typeof DEFAULT_TABS,
  callerProvidesSurface = false
) {
  return provisionWorktreeTerminals(host, {
    worktreeSelector: 'id:wt-1',
    worktreeId: 'wt-1',
    worktreePath: '/repo/wt-1',
    ...(withSetup ? { setup } : {}),
    hasStartupTerminal: false,
    ...(setupOnly !== undefined ? { setupOnly } : {}),
    ...(defaultTabs ? { defaultTabs } : {}),
    callerProvidesSurface,
    setupCommandPlatform: 'posix'
  })
}

describe('provisionWorktreeTerminals with a cleared creation choice', () => {
  it('creates only Setup for an explicit setup-only choice', async () => {
    const { host, titles } = createHost()
    await provisionWithSetup(host, true, true)
    expect(titles()).toEqual(['Setup'])
  })

  it('skips configured template commands when Setup is the only tab', async () => {
    const { host, titles } = createHost()
    await provisionWithSetup(host, true, true, DEFAULT_TABS)
    expect(titles()).toEqual(['Setup'])
    expect(host.setTabTitle).not.toHaveBeenCalled()
    expect(host.setTabColor).not.toHaveBeenCalled()
  })

  it.each([
    { withSetup: true, setupOnly: false, titles: ['Dev', 'Tests', 'Setup'] },
    { withSetup: false, setupOnly: true, titles: ['Dev', 'Tests'] }
  ])('keeps templates for blank or skipped setup: $withSetup/$setupOnly', async (test) => {
    const { host, titles } = createHost()
    await provisionWithSetup(host, test.withSetup, test.setupOnly, DEFAULT_TABS)
    expect(titles()).toEqual(test.titles)
    expect(host.createTerminal).toHaveBeenCalledWith('id:wt-1', {
      title: 'Dev',
      command: 'pnpm dev'
    })
  })

  it('keeps the primary terminal for an explicit plain-terminal choice', async () => {
    const { host, titles } = createHost()
    await provisionWithSetup(host, true, false)
    expect(titles()).toEqual([undefined, 'Setup'])
  })

  it('keeps the primary terminal without a cleared creation choice', async () => {
    const { host, titles } = createHost()
    await expect(provisionWithSetup(host)).resolves.toMatchObject({ setupSpawned: true })
    expect(titles()).toEqual([undefined, 'Setup'])
  })

  it('creates Setup without a shell when the caller supplies the primary surface', async () => {
    const { host, titles } = createHost()
    await provisionWithSetup(host, true, false, undefined, true)
    expect(titles()).toEqual(['Setup'])
  })

  it('falls back to a blank terminal when no setup runs', async () => {
    const { host, titles } = createHost()
    await provisionWithSetup(host, false, true)
    expect(titles()).toEqual([undefined])
  })

  it.each([false, true])(
    'opens a failed-Setup recovery shell only when the caller owes the surface (%s)',
    async (callerProvidesSurface) => {
      const { host, titles } = createHost()
      const createTerminal = vi.mocked(host.createTerminal)
      createTerminal.mockRejectedValueOnce(new Error('spawn failed'))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await expect(
        provisionWithSetup(host, true, true, undefined, callerProvidesSurface)
      ).resolves.toEqual({
        setupSpawned: false,
        setupTerminalHandle: null
      })
      expect(titles()).toEqual(callerProvidesSurface ? ['Setup'] : ['Setup', undefined])
      warn.mockRestore()
    }
  )
})
