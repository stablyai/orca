import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashWorktreeId } from '../main/terminal-history-id'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    // Why: attach now proves the backing pid is alive before replaying, so the
    // default managed PTY must report a live pid. Reuse the test runner's own
    // pid — always alive — so unrelated attach tests are not seen as dead.
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn
}))

vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import { MAX_RELAY_PTY_SESSIONS, type PtyHandler } from './pty-handler'
import {
  beginPtyHandlerTest,
  createMockDispatcher,
  createTestPtyHandler,
  testPtyId,
  endPtyHandlerTest
} from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

const PTY_1 = testPtyId(1)

// Why a real directory: revive drops an entry whose serialized cwd is gone from this host, so a
// fixture path that never existed would be skipped before the behaviour under test runs.
const LIVE_CWD = tmpdir()

describe('PtyHandler', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  it('revive restores pane identity env alongside hook-server coordinates', async () => {
    await dispatcher.callRequest('pty.spawn', {
      cols: 90,
      rows: 30,
      cwd: '/tmp',
      env: {
        ORCA_PANE_KEY: 'tab-5:1',
        ORCA_TAB_ID: 'tab-5',
        ORCA_WORKTREE_ID: 'wt-5'
      }
    })
    const state = (await dispatcher.callRequest('pty.serialize', { ids: [PTY_1] })) as string

    await handler.dispose({ waitForPhysicalExit: false })
    mockPtySpawn.mockClear()
    dispatcher = createMockDispatcher()
    handler = createTestPtyHandler(dispatcher)
    handler.addEnvAugmenter(() => ({
      ORCA_AGENT_HOOK_PORT: '12345',
      ORCA_AGENT_HOOK_TOKEN: 'abc-uuid'
    }))
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    // Why seeded: a revived pane must not inherit a feature selection from the
    // relay process's own environment.
    const oldShellFeatures = process.env.ORCA_SHELL_FEATURES
    process.env.ORCA_SHELL_FEATURES = 'ready,identity,markers,overlay'
    try {
      await dispatcher.callRequest('pty.revive', { state })
    } finally {
      if (oldShellFeatures === undefined) {
        delete process.env.ORCA_SHELL_FEATURES
      } else {
        process.env.ORCA_SHELL_FEATURES = oldShellFeatures
      }
      killSpy.mockRestore()
    }

    expect(mockPtySpawn).toHaveBeenCalledTimes(1)
    const callArgs = mockPtySpawn.mock.calls[0][2] as { env: Record<string, string> }
    expect(callArgs.env.ORCA_PANE_KEY).toBe('tab-5:1')
    expect(callArgs.env.ORCA_TAB_ID).toBe('tab-5')
    expect(callArgs.env.ORCA_WORKTREE_ID).toBe('wt-5')
    expect(callArgs.env.ORCA_AGENT_HOOK_PORT).toBe('12345')
    expect(callArgs.env.ORCA_AGENT_HOOK_TOKEN).toBe('abc-uuid')
    expect(callArgs.env.TERM).toBe('xterm-256color')
    expect(callArgs.env.TERM_PROGRAM).toBe('Orca')
    expect(callArgs.env.ORCA_SHELL_FEATURES).not.toContain('ready')
    expect(callArgs.env.ORCA_SHELL_FEATURES).not.toContain('identity')
  })

  it('fences both revived worktree identity and cwd with rollback', async () => {
    const finishSiblingAdmission = vi.fn()
    const beginWorktreePtySpawn = vi.fn((operationPath: string) => {
      if (operationPath === '/repo/removing/nested') {
        throw new Error('Remote worktree deletion already in progress')
      }
      return finishSiblingAdmission
    })
    handler.setWorktreeRemovalCoordinator({ beginWorktreePtySpawn })
    const state = JSON.stringify([
      {
        id: 'pty-7',
        pid: process.pid,
        cols: 80,
        rows: 24,
        cwd: '/repo/removing/nested',
        worktreeId: 'repo-id::/repo/sibling'
      }
    ])
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await expect(dispatcher.callRequest('pty.revive', { state })).rejects.toThrow(
        'Remote worktree deletion already in progress'
      )
    } finally {
      killSpy.mockRestore()
    }

    expect(beginWorktreePtySpawn.mock.calls.map(([operationPath]) => operationPath)).toEqual([
      '/repo/sibling',
      '/repo/removing/nested'
    ])
    expect(finishSiblingAdmission).toHaveBeenCalledOnce()
    expect(mockPtySpawn).not.toHaveBeenCalled()
  })

  it('applies the physical PTY cap to untrusted revive state', async () => {
    const state = JSON.stringify(
      Array.from({ length: MAX_RELAY_PTY_SESSIONS + 1 }, (_, index) => ({
        id: `pty-${index + 1}`,
        pid: process.pid,
        cols: 80,
        rows: 24,
        cwd: LIVE_CWD,
        worktreeId: 'repo-id::/repo'
      }))
    )
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await expect(dispatcher.callRequest('pty.revive', { state })).rejects.toThrow(
        'Maximum number of PTY sessions reached (50)'
      )
    } finally {
      killSpy.mockRestore()
    }

    expect(mockPtySpawn).toHaveBeenCalledTimes(MAX_RELAY_PTY_SESSIONS)
    expect(handler.activePtyCount).toBe(MAX_RELAY_PTY_SESSIONS)
  })

  it('deduplicates concurrent revive requests for the same physical PTY id', async () => {
    const state = JSON.stringify([
      {
        id: 'pty-7',
        pid: process.pid,
        cols: 80,
        rows: 24,
        cwd: LIVE_CWD,
        worktreeId: 'repo-id::/repo'
      }
    ])
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await Promise.all([
        dispatcher.callRequest('pty.revive', { state }),
        dispatcher.callRequest('pty.revive', { state })
      ])
    } finally {
      killSpy.mockRestore()
    }

    expect(mockPtySpawn).toHaveBeenCalledTimes(1)
    expect(handler.activePtyCount).toBe(1)
  })

  it('revive preserves the credential guard chosen for an SSH agent terminal', async () => {
    await dispatcher.callRequest('pty.spawn', {
      command: 'claude'
    })
    const state = (await dispatcher.callRequest('pty.serialize', { ids: [PTY_1] })) as string
    expect(JSON.parse(state)[0]?.gitCredentialPromptGuarded).toBe(true)

    handler.dispose()
    mockPtySpawn.mockClear()
    dispatcher = createMockDispatcher()
    handler = createTestPtyHandler(dispatcher)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await dispatcher.callRequest('pty.revive', { state })
    } finally {
      killSpy.mockRestore()
    }

    const revivedEnv = mockPtySpawn.mock.calls[0]?.[2]?.env as Record<string, string>
    expect(revivedEnv.GIT_TERMINAL_PROMPT).toBe('0')
    expect(revivedEnv.GCM_INTERACTIVE).toBe('never')
    expect(Object.values(revivedEnv)).toContain('credential.interactive')
    expect(Object.values(revivedEnv)).toContain('credential.guiPrompt')
  })

  it('revive treats legacy relay state as an ordinary unguarded terminal', async () => {
    const savedTerminalPrompt = process.env.GIT_TERMINAL_PROMPT
    const savedGcmInteractive = process.env.GCM_INTERACTIVE
    delete process.env.GIT_TERMINAL_PROMPT
    delete process.env.GCM_INTERACTIVE
    const state = JSON.stringify([
      {
        id: 'pty-legacy',
        pid: process.pid,
        cols: 80,
        rows: 24,
        cwd: process.cwd()
      }
    ])
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

    try {
      await dispatcher.callRequest('pty.revive', { state })
      const revivedEnv = mockPtySpawn.mock.calls[0]?.[2]?.env as Record<string, string>
      expect(revivedEnv.GIT_TERMINAL_PROMPT).toBeUndefined()
      expect(revivedEnv.GCM_INTERACTIVE).toBeUndefined()
    } finally {
      killSpy.mockRestore()
      if (savedTerminalPrompt === undefined) {
        delete process.env.GIT_TERMINAL_PROMPT
      } else {
        process.env.GIT_TERMINAL_PROMPT = savedTerminalPrompt
      }
      if (savedGcmInteractive === undefined) {
        delete process.env.GCM_INTERACTIVE
      } else {
        process.env.GCM_INTERACTIVE = savedGcmInteractive
      }
    }
  })

  it('normalizes an explicit empty TERM and preserves sanitized env deletions on revive', async () => {
    await dispatcher.callRequest('pty.spawn', {
      env: { TERM: '' },
      envToDelete: ['ORCA_STALE_TEST_ENV', '', 42]
    })

    const initialEnv = mockPtySpawn.mock.calls[0][2] as {
      name: string
      env: Record<string, string>
    }
    expect(initialEnv.name).toBe('xterm-256color')
    expect(initialEnv.env.TERM).toBe('xterm-256color')

    const state = (await dispatcher.callRequest('pty.serialize', { ids: [PTY_1] })) as string
    const [serialized] = JSON.parse(state) as {
      explicitTerm?: string
      envToDelete?: string[]
    }[]
    expect(serialized.explicitTerm).toBeUndefined()
    expect(serialized.envToDelete).toEqual(['ORCA_STALE_TEST_ENV'])

    await handler.dispose({ waitForPhysicalExit: false })
    mockPtySpawn.mockClear()
    dispatcher = createMockDispatcher()
    handler = createTestPtyHandler(dispatcher)
    handler.addEnvAugmenter(() => ({
      ORCA_STALE_TEST_ENV: '/tmp/revived-stale'
    }))
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await dispatcher.callRequest('pty.revive', { state })
    } finally {
      killSpy.mockRestore()
    }

    const revivedEnv = mockPtySpawn.mock.calls[0][2] as {
      name: string
      env: Record<string, string>
    }
    expect(revivedEnv.name).toBe('xterm-256color')
    expect(revivedEnv.env.TERM).toBe('xterm-256color')
    expect(revivedEnv.env.ORCA_STALE_TEST_ENV).toBeUndefined()
  })

  it('drops legacy empty explicit TERM metadata after revive', async () => {
    const state = JSON.stringify([
      {
        id: 'pty-8',
        pid: process.pid,
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        explicitTerm: '',
        envToDelete: ['ORCA_STALE_TEST_ENV']
      }
    ])
    handler.addEnvAugmenter(() => ({
      ORCA_STALE_TEST_ENV: '/tmp/legacy-empty-stale'
    }))
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await dispatcher.callRequest('pty.revive', { state })
    } finally {
      killSpy.mockRestore()
    }

    const revivedEnv = mockPtySpawn.mock.calls[0][2] as {
      name: string
      env: Record<string, string>
    }
    expect(revivedEnv.name).toBe('xterm-256color')
    expect(revivedEnv.env.TERM).toBe('xterm-256color')
    expect(revivedEnv.env.ORCA_STALE_TEST_ENV).toBeUndefined()

    const serializedState = (await dispatcher.callRequest('pty.serialize', {
      ids: ['pty-8']
    })) as string
    const [serialized] = JSON.parse(serializedState) as {
      explicitTerm?: string
      envToDelete?: string[]
    }[]
    expect(serialized.explicitTerm).toBeUndefined()
    expect(serialized.envToDelete).toEqual(['ORCA_STALE_TEST_ENV'])
  })

  it('preserves explicit TERM and env deletions through repeated revive cycles', async () => {
    await dispatcher.callRequest('pty.spawn', {
      env: { TERM: 'screen-256color' },
      envToDelete: ['ORCA_STALE_TEST_ENV']
    })
    let state = (await dispatcher.callRequest('pty.serialize', { ids: [PTY_1] })) as string

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await handler.dispose({ waitForPhysicalExit: false })
      mockPtySpawn.mockClear()
      dispatcher = createMockDispatcher()
      handler = createTestPtyHandler(dispatcher)
      handler.addEnvAugmenter(() => ({
        ORCA_STALE_TEST_ENV: '/tmp/first-revive'
      }))
      await dispatcher.callRequest('pty.revive', { state })

      const firstRevivedEnv = mockPtySpawn.mock.calls[0][2] as {
        name: string
        env: Record<string, string>
      }
      expect(firstRevivedEnv.name).toBe('screen-256color')
      expect(firstRevivedEnv.env.TERM).toBe('screen-256color')
      expect(firstRevivedEnv.env.ORCA_STALE_TEST_ENV).toBeUndefined()
      state = (await dispatcher.callRequest('pty.serialize', { ids: [PTY_1] })) as string
      expect(JSON.parse(state)).toMatchObject([
        {
          explicitTerm: 'screen-256color',
          envToDelete: ['ORCA_STALE_TEST_ENV']
        }
      ])

      await handler.dispose({ waitForPhysicalExit: false })
      mockPtySpawn.mockClear()
      dispatcher = createMockDispatcher()
      handler = createTestPtyHandler(dispatcher)
      handler.addEnvAugmenter(() => ({
        ORCA_STALE_TEST_ENV: '/tmp/second-revive'
      }))
      await dispatcher.callRequest('pty.revive', { state })
    } finally {
      killSpy.mockRestore()
    }

    const secondRevivedEnv = mockPtySpawn.mock.calls[0][2] as {
      name: string
      env: Record<string, string>
    }
    expect(secondRevivedEnv.name).toBe('screen-256color')
    expect(secondRevivedEnv.env.TERM).toBe('screen-256color')
    expect(secondRevivedEnv.env.ORCA_STALE_TEST_ENV).toBeUndefined()
  })

  it('revives legacy serialized entries with default TERM and no env deletions', async () => {
    handler.addEnvAugmenter(() => ({
      ORCA_STALE_TEST_ENV: '/tmp/legacy-stale'
    }))
    const state = JSON.stringify([
      {
        id: 'pty-7',
        pid: process.pid,
        cols: 80,
        rows: 24,
        cwd: process.cwd()
      }
    ])
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await dispatcher.callRequest('pty.revive', { state })
    } finally {
      killSpy.mockRestore()
    }

    const revivedEnv = mockPtySpawn.mock.calls[0][2] as { env: Record<string, string> }
    expect(revivedEnv.env.TERM).toBe('xterm-256color')
    expect(revivedEnv.env.ORCA_STALE_TEST_ENV).toBe('/tmp/legacy-stale')
  })

  it('revive preserves attach identity metadata without exporting hook identity env', async () => {
    const oldPaneKey = process.env.ORCA_PANE_KEY
    const oldTabId = process.env.ORCA_TAB_ID
    delete process.env.ORCA_PANE_KEY
    delete process.env.ORCA_TAB_ID
    try {
      await dispatcher.callRequest('pty.spawn', {
        cols: 90,
        rows: 30,
        cwd: '/tmp',
        env: { FOO: 'bar' },
        paneKey: 'tab-5:leaf-5',
        tabId: 'tab-5'
      })
    } finally {
      if (oldPaneKey === undefined) {
        delete process.env.ORCA_PANE_KEY
      } else {
        process.env.ORCA_PANE_KEY = oldPaneKey
      }
      if (oldTabId === undefined) {
        delete process.env.ORCA_TAB_ID
      } else {
        process.env.ORCA_TAB_ID = oldTabId
      }
    }
    const state = (await dispatcher.callRequest('pty.serialize', { ids: [PTY_1] })) as string

    await handler.dispose({ waitForPhysicalExit: false })
    mockPtySpawn.mockClear()
    dispatcher = createMockDispatcher()
    handler = createTestPtyHandler(dispatcher)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    delete process.env.ORCA_PANE_KEY
    delete process.env.ORCA_TAB_ID
    try {
      await dispatcher.callRequest('pty.revive', { state })
    } finally {
      killSpy.mockRestore()
      if (oldPaneKey === undefined) {
        delete process.env.ORCA_PANE_KEY
      } else {
        process.env.ORCA_PANE_KEY = oldPaneKey
      }
      if (oldTabId === undefined) {
        delete process.env.ORCA_TAB_ID
      } else {
        process.env.ORCA_TAB_ID = oldTabId
      }
    }

    const callArgs = mockPtySpawn.mock.calls[0][2] as { env: Record<string, string> }
    expect(callArgs.env.ORCA_PANE_KEY).toBeUndefined()
    expect(callArgs.env.ORCA_TAB_ID).toBeUndefined()

    await expect(
      dispatcher.callRequest('pty.attach', {
        id: PTY_1,
        expectedPaneKey: 'tab-other:leaf',
        expectedTabId: 'tab-other'
      })
    ).rejects.toThrow(`PTY "${PTY_1}" not found`)
  })

  // Why: `cwd` is the last serialized field revive took on trust. It proves the directory existed
  // when the client wrote it down, not that it exists now -- node-pty answers a removed one by
  // _exit(1)-ing the child on POSIX and by throwing on Windows, and the throw escapes the loop.
  it('skips a pane whose serialized cwd is gone from this host, keeping the batch', async () => {
    const removedCwd = join(tmpdir(), `orca-revive-removed-${process.pid}`)
    rmSync(removedCwd, { force: true, recursive: true })
    const state = JSON.stringify([
      { id: 'pty-20', pid: process.pid, cols: 80, rows: 24, cwd: removedCwd },
      { id: 'pty-21', pid: process.pid, cols: 80, rows: 24, cwd: LIVE_CWD }
    ])
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await dispatcher.callRequest('pty.revive', { state })
    } finally {
      killSpy.mockRestore()
    }

    // The later entry still revived, and no other directory stood in for the first.
    expect(mockPtySpawn).toHaveBeenCalledTimes(1)
    expect((mockPtySpawn.mock.calls[0][2] as { cwd: string }).cwd).toBe(LIVE_CWD)
    const live = (await dispatcher.callRequest('pty.serialize', {
      ids: ['pty-20', 'pty-21']
    })) as string
    expect(JSON.parse(live).map((entry: { id: string }) => entry.id)).toEqual(['pty-21'])
  })

  describe('a Windows relay reviving a WSL pane', () => {
    const worktreeId = 'r::/remote/wsl-worktree'
    const historyFile = join(
      homedir(),
      '.orca-remote',
      'terminal-history',
      `${hashWorktreeId(worktreeId)}-bash_history`
    )
    let previousPlatform: PropertyDescriptor | undefined

    beforeEach(() => {
      previousPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    })

    afterEach(() => {
      if (previousPlatform) {
        Object.defineProperty(process, 'platform', previousPlatform)
      }
      rmSync(historyFile, { force: true })
    })

    /** Spawn a WSL pane, serialize it, then revive it into a fresh handler. */
    async function reviveWslPane(): Promise<void> {
      await dispatcher.callRequest('pty.spawn', {
        cols: 80,
        rows: 24,
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Ubuntu',
        worktreeId,
        historyIsolationEnabled: true
      })
      const state = (await dispatcher.callRequest('pty.serialize', { ids: [PTY_1] })) as string

      await handler.dispose({ waitForPhysicalExit: false })
      mockPtySpawn.mockClear()
      rmSync(historyFile, { force: true })
      dispatcher = createMockDispatcher()
      handler = createTestPtyHandler(dispatcher)

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      try {
        await dispatcher.callRequest('pty.revive', { state })
      } finally {
        killSpy.mockRestore()
      }
    }

    // The #15236 gap: revive called resolveDefaultShell() and ignored the
    // entry's override, so a restarted relay silently handed the user a
    // PowerShell pane where a WSL one had been.
    it('relaunches wsl.exe in the pane\u2019s own distro instead of the host default shell', async () => {
      await reviveWslPane()

      const [shell, args] = mockPtySpawn.mock.calls[0] as [string, string[]]
      expect(shell).toBe('wsl.exe')
      expect(args).toEqual(['-d', 'Ubuntu'])
    })

    it('scopes HISTFILE past the wsl.exe wrapper and carries it over WSLENV', async () => {
      await reviveWslPane()

      const spawnEnv = mockPtySpawn.mock.calls[0][2]?.env as Record<string, string>
      expect(spawnEnv.HISTFILE?.endsWith(`${hashWorktreeId(worktreeId)}-bash_history`)).toBe(true)
      expect(spawnEnv.WSLENV?.split(':')).toContain('HISTFILE')
      // Deletion is unchanged because the file still lives on the relay host.
      expect(existsSync(historyFile)).toBe(true)
    })

    // Why: a revived pane is serialized again on the next restart, so dropping
    // the override there is the same defect one reconnect later.
    it('keeps the override across a second serialize/revive round trip', async () => {
      await reviveWslPane()

      const state = (await dispatcher.callRequest('pty.serialize', { ids: [PTY_1] })) as string

      expect(JSON.parse(state)[0]).toMatchObject({
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Ubuntu'
      })
    })

    // Why: this field is replayed from state the relay hands a client and takes
    // back unvalidated, and it lands in argv.
    it('drops an over-long distro name rather than passing it to wsl.exe', async () => {
      const state = JSON.stringify([
        {
          id: 'pty-11',
          pid: process.pid,
          cols: 80,
          rows: 24,
          cwd: LIVE_CWD,
          shellOverride: 'wsl.exe',
          terminalWindowsWslDistro: 'U'.repeat(257)
        }
      ])
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      try {
        await dispatcher.callRequest('pty.revive', { state })
      } finally {
        killSpy.mockRestore()
      }

      const [shell, args] = mockPtySpawn.mock.calls[0] as [string, string[]]
      expect(shell).toBe('wsl.exe')
      expect(args).toEqual([])
    })

    // Why: the override's whole point is that the pane keeps its own shell, so a
    // shell that no longer exists must cost that pane and nothing else.
    it('skips a pane whose overridden shell can no longer spawn, keeping the batch', async () => {
      const state = JSON.stringify([
        {
          id: 'pty-12',
          pid: process.pid,
          cols: 80,
          rows: 24,
          cwd: LIVE_CWD,
          shellOverride: 'wsl.exe'
        },
        { id: 'pty-13', pid: process.pid, cols: 80, rows: 24, cwd: LIVE_CWD }
      ])
      mockPtySpawn.mockImplementationOnce(() => {
        throw new Error('spawn wsl.exe ENOENT')
      })
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      try {
        await dispatcher.callRequest('pty.revive', { state })
      } finally {
        killSpy.mockRestore()
      }

      // The second entry still revived, and no other shell stood in for the first.
      expect(mockPtySpawn).toHaveBeenCalledTimes(2)
      const live = (await dispatcher.callRequest('pty.serialize', {
        ids: ['pty-12', 'pty-13']
      })) as string
      expect(JSON.parse(live).map((entry: { id: string }) => entry.id)).toEqual(['pty-13'])
    })

    // Why: relayHostDirectoryExists stats the relay's own filesystem, and a wsl.exe pane's cwd
    // lives in the guest -- the same host boundary requireRelaySpawnCwd already honours.
    it('revives a WSL pane whose cwd is a guest path this host cannot stat', async () => {
      const state = JSON.stringify([
        {
          id: 'pty-14',
          pid: process.pid,
          cols: 80,
          rows: 24,
          cwd: '/home/dev/guest-only-worktree',
          shellOverride: 'wsl.exe',
          terminalWindowsWslDistro: 'Ubuntu'
        }
      ])
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      try {
        await dispatcher.callRequest('pty.revive', { state })
      } finally {
        killSpy.mockRestore()
      }

      expect(mockPtySpawn).toHaveBeenCalledTimes(1)
      expect((mockPtySpawn.mock.calls[0][2] as { cwd: string }).cwd).toBe(
        '/home/dev/guest-only-worktree'
      )
    })

    it('degrades one entry with an unsupported override without failing the batch', async () => {
      const state = JSON.stringify([
        {
          id: 'pty-9',
          pid: process.pid,
          cols: 80,
          rows: 24,
          cwd: LIVE_CWD,
          shellOverride: 'nc.exe'
        },
        { id: 'pty-10', pid: process.pid, cols: 80, rows: 24, cwd: LIVE_CWD }
      ])
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      try {
        await dispatcher.callRequest('pty.revive', { state })
      } finally {
        killSpy.mockRestore()
      }

      expect(mockPtySpawn).toHaveBeenCalledTimes(2)
      expect(mockPtySpawn.mock.calls.map(([shell]) => shell)).not.toContain('nc.exe')
    })
  })
})
