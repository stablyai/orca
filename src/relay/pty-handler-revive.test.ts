import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

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

import { MAX_RELAY_PTY_SESSIONS, PtyHandler } from './pty-handler'
import type { RelayDispatcher } from './dispatcher'
import {
  beginPtyHandlerTest,
  createMockDispatcher,
  endPtyHandlerTest
} from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

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
    const state = (await dispatcher.callRequest('pty.serialize', { ids: ['pty-1'] })) as string

    await handler.dispose({ waitForPhysicalExit: false })
    mockPtySpawn.mockClear()
    dispatcher = createMockDispatcher()
    handler = new PtyHandler(dispatcher as unknown as RelayDispatcher)
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
        cwd: '/repo',
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
        cwd: '/repo',
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
    const state = (await dispatcher.callRequest('pty.serialize', { ids: ['pty-1'] })) as string
    expect(JSON.parse(state)[0]?.gitCredentialPromptGuarded).toBe(true)

    handler.dispose()
    mockPtySpawn.mockClear()
    dispatcher = createMockDispatcher()
    handler = new PtyHandler(dispatcher as unknown as RelayDispatcher)
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

    const state = (await dispatcher.callRequest('pty.serialize', { ids: ['pty-1'] })) as string
    const [serialized] = JSON.parse(state) as {
      explicitTerm?: string
      envToDelete?: string[]
    }[]
    expect(serialized.explicitTerm).toBeUndefined()
    expect(serialized.envToDelete).toEqual(['ORCA_STALE_TEST_ENV'])

    await handler.dispose({ waitForPhysicalExit: false })
    mockPtySpawn.mockClear()
    dispatcher = createMockDispatcher()
    handler = new PtyHandler(dispatcher as unknown as RelayDispatcher)
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
    let state = (await dispatcher.callRequest('pty.serialize', { ids: ['pty-1'] })) as string

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await handler.dispose({ waitForPhysicalExit: false })
      mockPtySpawn.mockClear()
      dispatcher = createMockDispatcher()
      handler = new PtyHandler(dispatcher as unknown as RelayDispatcher)
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
      state = (await dispatcher.callRequest('pty.serialize', { ids: ['pty-1'] })) as string
      expect(JSON.parse(state)).toMatchObject([
        {
          explicitTerm: 'screen-256color',
          envToDelete: ['ORCA_STALE_TEST_ENV']
        }
      ])

      await handler.dispose({ waitForPhysicalExit: false })
      mockPtySpawn.mockClear()
      dispatcher = createMockDispatcher()
      handler = new PtyHandler(dispatcher as unknown as RelayDispatcher)
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
    const state = (await dispatcher.callRequest('pty.serialize', { ids: ['pty-1'] })) as string

    await handler.dispose({ waitForPhysicalExit: false })
    mockPtySpawn.mockClear()
    dispatcher = createMockDispatcher()
    handler = new PtyHandler(dispatcher as unknown as RelayDispatcher)
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
        id: 'pty-1',
        expectedPaneKey: 'tab-other:leaf',
        expectedTabId: 'tab-other'
      })
    ).rejects.toThrow('PTY "pty-1" not found')
  })
})
