import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveSetupAgentSequenceLaunchCommand,
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV
} from '../shared/setup-agent-sequencing'
import { stripLegacyTerminalShimEnv } from '../main/pty/legacy-terminal-shim-dir'
import { fishHistorySessionName, relayFishHistorySessionName } from '../main/fish-history-session'
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

import { PtyHandler } from './pty-handler'
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

  it("does not forward MCode's own NODE_ENV into the spawned shell", async () => {
    // Why: NODE_ENV in the relay host process is a build-mode flag, not the
    // user's; leaking it breaks `next build` and Vitest in the terminal.
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    try {
      await dispatcher.callRequest('pty.spawn', { cols: 80, rows: 24 })
    } finally {
      if (previous === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previous
      }
    }

    const spawnOptions = mockPtySpawn.mock.calls[0][2] as { env: Record<string, string> }
    expect(spawnOptions.env.NODE_ENV).toBeUndefined()
    const expectedEnv = { PATH: process.env.PATH ?? '' }
    stripLegacyTerminalShimEnv(expectedEnv, process.platform)
    expect(spawnOptions.env.PATH).toBe(expectedEnv.PATH)
  })

  it('does not inherit legacy attribution state from the relay process', async () => {
    const keys = ['MCODE_ENABLE_GIT_ATTRIBUTION', 'MCODE_ATTRIBUTION_SHIM_DIR', 'PATH'] as const
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    process.env.MCODE_ENABLE_GIT_ATTRIBUTION = '1'
    process.env.MCODE_ATTRIBUTION_SHIM_DIR = '/tmp/mcode-terminal-attribution/posix'
    process.env.PATH = '/tmp/mcode-terminal-attribution/posix:/usr/bin'

    try {
      await dispatcher.callRequest('pty.spawn', { cols: 80, rows: 24 })
      const spawnedEnv = mockPtySpawn.mock.calls.at(-1)?.[2] as {
        env: Record<string, string>
      }
      expect(spawnedEnv.env.PATH).toBe('/usr/bin')
      expect(spawnedEnv.env.MCODE_ENABLE_GIT_ATTRIBUTION).toBeUndefined()
      expect(spawnedEnv.env.MCODE_ATTRIBUTION_SHIM_DIR).toBeUndefined()

      const state = (await dispatcher.callRequest('pty.serialize', {
        ids: ['pty-1']
      })) as string
      await handler.dispose({ waitForPhysicalExit: false })
      mockPtySpawn.mockClear()
      dispatcher = createMockDispatcher()
      handler = new PtyHandler(dispatcher as unknown as RelayDispatcher)
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      try {
        await dispatcher.callRequest('pty.revive', { state })
      } finally {
        killSpy.mockRestore()
      }

      const revivedEnv = mockPtySpawn.mock.calls.at(-1)?.[2] as {
        env: Record<string, string>
      }
      expect(revivedEnv.env.PATH).toBe('/usr/bin')
      expect(revivedEnv.env.MCODE_ENABLE_GIT_ATTRIBUTION).toBeUndefined()
      expect(revivedEnv.env.MCODE_ATTRIBUTION_SHIM_DIR).toBeUndefined()
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })

  it('keeps a renderer-supplied NODE_ENV for the spawned shell', async () => {
    // Why: only the ambient value is stripped; an explicit request still wins.
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    try {
      await dispatcher.callRequest('pty.spawn', {
        cols: 80,
        rows: 24,
        env: { NODE_ENV: 'production' }
      })
    } finally {
      if (previous === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previous
      }
    }

    const spawnOptions = mockPtySpawn.mock.calls[0][2] as { env: Record<string, string> }
    expect(spawnOptions.env.NODE_ENV).toBe('production')
  })

  describe('history isolation off', () => {
    // Why isolation OFF: injectRelayFishHistoryEnv runs only for a fish pane with
    // isolation on, but fish EXPORTS fish_history, so a relay launched from an MCode
    // fish pane inherits one on EVERY path — and it names someone else's worktree
    // (a desktop-minted name names a directory that does not exist here at all).
    it.each([
      [
        'a relay-minted session',
        relayFishHistorySessionName(hashWorktreeId('r::/other')),
        undefined
      ],
      ['a desktop-minted session', fishHistorySessionName(hashWorktreeId('r::/other')), undefined],
      ['a user value', 'mine', 'mine']
    ])('%s inherited from the relay process env', async (_kind, inherited, expected) => {
      const previous = process.env.fish_history
      process.env.fish_history = inherited
      try {
        await dispatcher.callRequest('pty.spawn', { cols: 80, rows: 24 })
      } finally {
        if (previous === undefined) {
          delete process.env.fish_history
        } else {
          process.env.fish_history = previous
        }
      }

      const spawnEnv = mockPtySpawn.mock.calls.at(-1)?.[2]?.env as Record<string, string>
      expect(spawnEnv.fish_history).toBe(expected)
    })

    it.each([
      [
        'a relay-minted path',
        `${process.env.HOME ?? ''}/.mcode-remote/terminal-history/aabbccddeeff0011-zsh_history`,
        undefined
      ],
      [
        'a desktop-minted path',
        '/fake/userData/terminal-history/aabbccddeeff0011/zsh_history',
        undefined
      ],
      ['a user value', '/home/me/.zsh_history', '/home/me/.zsh_history']
    ])(
      '%s inherited as HISTFILE from the relay process env',
      async (_kind, inherited, expected) => {
        const previous = process.env.HISTFILE
        process.env.HISTFILE = inherited
        try {
          await dispatcher.callRequest('pty.spawn', { cols: 80, rows: 24 })
        } finally {
          if (previous === undefined) {
            delete process.env.HISTFILE
          } else {
            process.env.HISTFILE = previous
          }
        }

        const spawnEnv = mockPtySpawn.mock.calls.at(-1)?.[2]?.env as Record<string, string>
        expect(spawnEnv.HISTFILE).toBe(expected)
      }
    )

    // Why unconditionally, not only with isolation on: injectRelayHistoryEnv is
    // what normally mints (and first clears) MCODE_HISTFILE, and it runs only
    // with isolation on. An inherited one — the relay can be launched from an
    // MCode pane — would otherwise reach the remote wrapper on the disabled and
    // revive paths, re-exporting another worktree's history path (#11146) and
    // wrapping a zsh pane nothing asked to wrap.
    it.each([
      [
        'a relay-minted path',
        `${process.env.HOME ?? ''}/.mcode-remote/terminal-history/aabbccddeeff0011-zsh_history`
      ],
      ['a desktop-minted path', '/fake/userData/terminal-history/aabbccddeeff0011/zsh_history'],
      ['a user value', '/home/me/.zsh_history']
    ])(
      'drops %s inherited as MCODE_HISTFILE from the relay process env',
      async (_kind, inherited) => {
        const previous = process.env.MCODE_HISTFILE
        process.env.MCODE_HISTFILE = inherited
        try {
          await dispatcher.callRequest('pty.spawn', { cols: 80, rows: 24 })
        } finally {
          if (previous === undefined) {
            delete process.env.MCODE_HISTFILE
          } else {
            process.env.MCODE_HISTFILE = previous
          }
        }

        const spawnEnv = mockPtySpawn.mock.calls.at(-1)?.[2]?.env as Record<string, string>
        expect(spawnEnv.MCODE_HISTFILE).toBeUndefined()
      }
    )

    it('drops an MCODE_HISTFILE handed over in the client env', async () => {
      await dispatcher.callRequest('pty.spawn', {
        cols: 80,
        rows: 24,
        env: { MCODE_HISTFILE: '/fake/userData/terminal-history/aabbccddeeff0011/zsh_history' }
      })

      const spawnEnv = mockPtySpawn.mock.calls.at(-1)?.[2]?.env as Record<string, string>
      expect(spawnEnv.MCODE_HISTFILE).toBeUndefined()
    })

    it('drops a desktop-minted session handed over in the client env', async () => {
      await dispatcher.callRequest('pty.spawn', {
        cols: 80,
        rows: 24,
        env: { fish_history: fishHistorySessionName(hashWorktreeId('r::/other')) }
      })

      const spawnEnv = mockPtySpawn.mock.calls.at(-1)?.[2]?.env as Record<string, string>
      expect(spawnEnv.fish_history).toBeUndefined()
    })
  })

  describe('history isolation for a Windows relay launching WSL', () => {
    const wslWorktreeId = 'r::/remote/wsl-worktree'
    const wslHistoryFile = join(
      homedir(),
      '.mcode-remote',
      'terminal-history',
      `${hashWorktreeId(wslWorktreeId)}-bash_history`
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
      rmSync(wslHistoryFile, { force: true })
    })

    const spawnWslPane = (): Promise<unknown> =>
      dispatcher.callRequest('pty.spawn', {
        cols: 80,
        rows: 24,
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Ubuntu',
        worktreeId: wslWorktreeId,
        historyIsolationEnabled: true
      })

    it('scopes HISTFILE past the wsl.exe wrapper and carries it over WSLENV', async () => {
      await spawnWslPane()

      const spawnEnv = mockPtySpawn.mock.calls.at(-1)?.[2]?.env as Record<string, string>
      expect(spawnEnv.HISTFILE?.endsWith(`${hashWorktreeId(wslWorktreeId)}-bash_history`)).toBe(
        true
      )
      expect(spawnEnv.WSLENV?.split(':')).toContain('HISTFILE')
    })

    // The injected file lives on the relay host, so the existing host-side
    // unlink is the deletion counterpart — no distro-scoped root is involved.
    it('deletes the injected file through the ordinary relay history deletion', async () => {
      await spawnWslPane()
      expect(existsSync(wslHistoryFile)).toBe(true)

      await dispatcher.callRequest('pty.deleteWorktreeHistory', { worktreeId: wslWorktreeId })

      expect(existsSync(wslHistoryFile)).toBe(false)
    })

    // Guest fish keeps its history inside the distro, where relay deletion cannot
    // reach it, so wsl.exe panes intentionally stay on shared fish history.
    it('does not mint a fish session for a WSL pane', async () => {
      await spawnWslPane()

      const spawnEnv = mockPtySpawn.mock.calls.at(-1)?.[2]?.env as Record<string, string>
      expect(spawnEnv.fish_history).toBeUndefined()
    })
  })

  it('guards SSH agent terminals after merging the relay inherited Git config', async () => {
    const gitConfigKeys = [
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0',
      'GIT_CONFIG_KEY_1',
      'GIT_CONFIG_VALUE_1',
      'GIT_CONFIG_KEY_2',
      'GIT_CONFIG_VALUE_2'
    ] as const
    const saved = Object.fromEntries(gitConfigKeys.map((key) => [key, process.env[key]]))
    process.env.GIT_CONFIG_COUNT = '3'
    process.env.GIT_CONFIG_KEY_0 = 'core.quotePath'
    process.env.GIT_CONFIG_VALUE_0 = 'false'
    process.env.GIT_CONFIG_KEY_1 = 'base.one'
    process.env.GIT_CONFIG_VALUE_1 = 'one'
    process.env.GIT_CONFIG_KEY_2 = 'base.two'
    process.env.GIT_CONFIG_VALUE_2 = 'two'

    try {
      await dispatcher.callRequest('pty.spawn', {
        command: 'claude',
        env: {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.proxy',
          GIT_CONFIG_VALUE_0: 'http://proxy.invalid'
        }
      })

      const spawnEnv = mockPtySpawn.mock.calls[0]?.[2]?.env as Record<string, string>
      expect(spawnEnv.GIT_TERMINAL_PROMPT).toBe('0')
      expect(spawnEnv.GCM_INTERACTIVE).toBe('never')
      expect(spawnEnv.GIT_CONFIG_COUNT).toBe('3')
      expect(spawnEnv.GIT_CONFIG_KEY_0).toBe('http.proxy')
      expect(spawnEnv.GIT_CONFIG_KEY_1).toBe('credential.interactive')
      expect(spawnEnv.GIT_CONFIG_KEY_2).toBe('credential.guiPrompt')
      expect(spawnEnv.GIT_CONFIG_KEY_3).toBeUndefined()
    } finally {
      for (const key of gitConfigKeys) {
        if (saved[key] === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = saved[key]
        }
      }
    }
  })

  it('guards a trusted SSH agent when its command uses a custom wrapper', async () => {
    await dispatcher.callRequest('pty.spawn', {
      command: 'cd /repo && custom-agent-wrapper',
      launchAgent: 'claude'
    })

    const spawnEnv = mockPtySpawn.mock.calls[0]?.[2]?.env as Record<string, string>
    expect(spawnEnv.GIT_TERMINAL_PROMPT).toBe('0')
    expect(spawnEnv.GCM_INTERACTIVE).toBe('never')
    expect(Object.values(spawnEnv)).toContain('credential.interactive')
    expect(Object.values(spawnEnv)).toContain('credential.guiPrompt')
  })

  it('leaves an ordinary Windows SSH user terminal unchanged', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    try {
      await dispatcher.callRequest('pty.spawn', {
        env: {
          GIT_TERMINAL_PROMPT: '1',
          GCM_INTERACTIVE: 'auto',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.quotePath',
          GIT_CONFIG_VALUE_0: 'false'
        }
      })
      const userEnv = mockPtySpawn.mock.calls[0]?.[2]?.env as Record<string, string>
      expect(userEnv.GIT_TERMINAL_PROMPT).toBe('1')
      expect(userEnv.GCM_INTERACTIVE).toBe('auto')
      expect(userEnv.GIT_CONFIG_COUNT).toBe('1')
      expect(userEnv.GIT_CONFIG_KEY_0).toBe('core.quotePath')
      expect(userEnv.GIT_CONFIG_KEY_1).toBeUndefined()
      const state = (await dispatcher.callRequest('pty.serialize', { ids: ['pty-1'] })) as string
      expect(JSON.parse(state)[0]?.gitCredentialPromptGuarded).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('applies env augmenters after process.env and renderer-supplied env (augmenter wins on key conflict)', async () => {
    handler.addEnvAugmenter(() => ({
      MCODE_AGENT_HOOK_PORT: '12345',
      MCODE_AGENT_HOOK_TOKEN: 'abc-uuid',
      // Why: also override a key the renderer supplied below so the test pins
      // the documented "augmenter wins on key conflict" invariant — see the
      // doc-comment on addEnvAugmenter in pty-handler.ts.
      MCODE_PANE_KEY: 'augmenter-wins'
    }))

    await dispatcher.callRequest('pty.spawn', {
      cols: 80,
      rows: 24,
      env: { MCODE_PANE_KEY: 'tab-1:0', MCODE_TAB_ID: 'tab-1' }
    })

    expect(mockPtySpawn).toHaveBeenCalled()
    const callArgs = mockPtySpawn.mock.calls[0][2] as { env: Record<string, string> }
    expect(callArgs.env.MCODE_AGENT_HOOK_PORT).toBe('12345')
    expect(callArgs.env.MCODE_AGENT_HOOK_TOKEN).toBe('abc-uuid')
    // Augmenter override beats the renderer-supplied value:
    expect(callArgs.env.MCODE_PANE_KEY).toBe('augmenter-wins')
    // Renderer-supplied keys not in augmenter map flow through:
    expect(callArgs.env.MCODE_TAB_ID).toBe('tab-1')
  })

  it('passes PTY and explicit launch identity to env augmenters', async () => {
    const seenContexts: {
      id: string
      paneKey?: string
      launchAgent?: string
      env: Record<string, string>
    }[] = []
    handler.addEnvAugmenter((ctx) => {
      seenContexts.push(ctx)
      return {
        OVERLAY_ID: ctx.paneKey ?? ctx.id
      }
    })

    await dispatcher.callRequest('pty.spawn', {
      env: { MCODE_PANE_KEY: 'tab-context:0' },
      launchAgent: 'pi'
    })
    await dispatcher.callRequest('pty.spawn', {})

    const firstEnv = mockPtySpawn.mock.calls[0][2] as { env: Record<string, string> }
    const secondEnv = mockPtySpawn.mock.calls[1][2] as { env: Record<string, string> }
    expect(seenContexts[0]).toMatchObject({
      id: 'pty-1',
      paneKey: 'tab-context:0',
      launchAgent: 'pi',
      env: { MCODE_PANE_KEY: 'tab-context:0' }
    })
    expect(seenContexts[1]).toMatchObject({ id: 'pty-2', paneKey: undefined })
    expect(firstEnv.env.OVERLAY_ID).toBe('tab-context:0')
    expect(secondEnv.env.OVERLAY_ID).toBe('pty-2')
  })

  it('passes process and renderer env to env augmenters before augmenter overrides are applied', async () => {
    const oldProcessValue = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = '/remote/default-opencode'
    try {
      handler.addEnvAugmenter((ctx) => ({
        SEEN_OPENCODE_CONFIG_DIR: ctx.env.OPENCODE_CONFIG_DIR,
        SEEN_PI_CODING_AGENT_DIR: ctx.env.PI_CODING_AGENT_DIR
      }))

      await dispatcher.callRequest('pty.spawn', {
        env: {
          OPENCODE_CONFIG_DIR: '/remote/renderer-opencode',
          PI_CODING_AGENT_DIR: '/remote/pi'
        }
      })
    } finally {
      if (oldProcessValue === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR
      } else {
        process.env.OPENCODE_CONFIG_DIR = oldProcessValue
      }
    }

    const spawnEnv = mockPtySpawn.mock.calls[0][2] as {
      name: string
      env: Record<string, string>
    }
    expect(spawnEnv.name).toBe('xterm-256color')
    expect(spawnEnv.env.SEEN_OPENCODE_CONFIG_DIR).toBe('/remote/renderer-opencode')
    expect(spawnEnv.env.SEEN_PI_CODING_AGENT_DIR).toBe('/remote/pi')
  })

  it('applies identity defaults, then deletions, while preserving explicit TERM', async () => {
    handler.addEnvAugmenter(() => ({
      TERM: 'augmenter-term',
      TERM_PROGRAM: 'augmenter-terminal',
      MCODE_STALE_TEST_ENV: '/tmp/augmenter-stale'
    }))

    await dispatcher.callRequest('pty.spawn', {
      env: {
        TERM: 'screen-256color',
        TERM_PROGRAM: 'renderer-terminal',
        MCODE_STALE_TEST_ENV: '/tmp/renderer-stale'
      },
      envToDelete: ['TERM_PROGRAM', 'MCODE_STALE_TEST_ENV']
    })

    const spawnEnv = mockPtySpawn.mock.calls[0][2] as {
      name: string
      env: Record<string, string>
    }
    expect(spawnEnv.name).toBe('screen-256color')
    expect(spawnEnv.env.TERM).toBe('screen-256color')
    expect(spawnEnv.env.COLORTERM).toBe('truecolor')
    expect(spawnEnv.env.FORCE_HYPERLINK).toBe('1')
    expect(spawnEnv.env.TERM_PROGRAM).toBeUndefined()
    expect(spawnEnv.env.MCODE_STALE_TEST_ENV).toBeUndefined()
  })

  it('replaces an ambient TERM=dumb when no explicit TERM is supplied', async () => {
    const previousTerm = process.env.TERM
    process.env.TERM = 'dumb'
    try {
      await dispatcher.callRequest('pty.spawn', {})
    } finally {
      if (previousTerm === undefined) {
        delete process.env.TERM
      } else {
        process.env.TERM = previousTerm
      }
    }

    const spawnEnv = mockPtySpawn.mock.calls[0][2] as {
      name: string
      env: Record<string, string>
    }
    expect(spawnEnv.name).toBe('xterm-256color')
    expect(spawnEnv.env.TERM).toBe('xterm-256color')
    expect(spawnEnv.env.TERM_PROGRAM).toBe('MCode')
  })

  it('expands variables in PATH before spawning a Windows relay shell', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    try {
      await dispatcher.callRequest('pty.spawn', {
        env: {
          MCODE_PATH_ROOT: 'C:\\Users\\mcode\\AppData\\Local',
          PATH: '%mcode_path_root%\\agy\\bin;C:\\Windows'
        }
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    const spawnEnv = mockPtySpawn.mock.calls[0][2] as { env: Record<string, string> }
    expect(spawnEnv.env.PATH).toBe('C:\\Users\\mcode\\AppData\\Local\\agy\\bin;C:\\Windows')
  })

  it('uses the safe terminal default when TERM is deleted without a custom value', async () => {
    await dispatcher.callRequest('pty.spawn', {
      envToDelete: ['TERM']
    })

    const spawnEnv = mockPtySpawn.mock.calls[0][2] as {
      name: string
      env: Record<string, string>
    }
    expect(spawnEnv.name).toBe('xterm-256color')
    expect(spawnEnv.env.TERM).toBe('xterm-256color')
  })

  it('lets relay env augmenters resolve the original sequenced startup command hint', async () => {
    handler.addEnvAugmenter((ctx) => ({
      SEEN_LAUNCH_COMMAND_HINT: resolveSetupAgentSequenceLaunchCommand(ctx.env, ctx.command) ?? ''
    }))

    await dispatcher.callRequest('pty.spawn', {
      command: 'powershell wait-wrapper',
      env: { [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: 'omp --resume' }
    })

    const spawnEnv = mockPtySpawn.mock.calls[0][2] as { env: Record<string, string> }
    expect(spawnEnv.env.SEEN_LAUNCH_COMMAND_HINT).toBe('omp --resume')
  })

  it.skipIf(process.platform === 'win32')(
    'wraps bash spawns to restore overlay env after remote startup files',
    async () => {
      const oldShell = process.env.SHELL
      const oldHome = process.env.HOME
      const oldMCodePi = process.env.MCODE_PI_CODING_AGENT_DIR
      const homeDir = mkdtempSync(join(tmpdir(), 'relay-pty-shell-launch-'))

      process.env.SHELL = '/bin/bash'
      process.env.HOME = homeDir
      delete process.env.MCODE_PI_CODING_AGENT_DIR
      try {
        if (!existsSync('/bin/bash')) {
          return
        }

        handler.addEnvAugmenter(() => ({
          OPENCODE_CONFIG_DIR: '/remote/overlay/opencode',
          MCODE_OPENCODE_CONFIG_DIR: '/remote/overlay/opencode',
          MCODE_OMP_STATUS_EXTENSION: '/remote/.omp/agent/extensions/mcode-agent-status.ts'
        }))

        await dispatcher.callRequest('pty.spawn', { env: { HOME: homeDir } })
      } finally {
        if (oldShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = oldShell
        }
        if (oldHome === undefined) {
          delete process.env.HOME
        } else {
          process.env.HOME = oldHome
        }
        if (oldMCodePi === undefined) {
          delete process.env.MCODE_PI_CODING_AGENT_DIR
        } else {
          process.env.MCODE_PI_CODING_AGENT_DIR = oldMCodePi
        }
      }

      const shellArgs = mockPtySpawn.mock.calls[0][1]
      const spawnOptions = mockPtySpawn.mock.calls[0][2] as { env: Record<string, string> }
      const rcfile = join(homeDir, '.mcode-relay', 'shell-ready', 'bash', 'rcfile')

      expect(shellArgs).toEqual(['--rcfile', rcfile])
      expect(spawnOptions.env.MCODE_OPENCODE_CONFIG_DIR).toBe('/remote/overlay/opencode')
      expect(spawnOptions.env.MCODE_PI_CODING_AGENT_DIR).toBeUndefined()
      expect(readFileSync(rcfile, 'utf8')).toContain(
        'export OPENCODE_CONFIG_DIR="${MCODE_OPENCODE_CONFIG_DIR}"'
      )
      expect(readFileSync(rcfile, 'utf8')).not.toContain('MCODE_PI_CODING_AGENT_DIR')
      expect(readFileSync(rcfile, 'utf8')).toContain('command omp --extension')

      rmSync(homeDir, { recursive: true, force: true })
    }
  )
})
