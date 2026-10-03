import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hashWorktreeId } from '../main/terminal-history-id'
import {
  beginPtyHandlerTest,
  createMockDispatcher,
  createTestPtyHandler,
  endPtyHandlerTest,
  testPtyId
} from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'
import type { PtyHandler } from './pty-handler'

const mocks = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    // Reuse the runner's own (always-alive) pid so revive's liveness probe passes.
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
vi.mock('node-pty', () => ({ spawn: mocks.mockPtySpawn }))
vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mocks.mockCreateShellPromptReadinessProbe
}))
vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

const PTY_1 = testPtyId(1)

// An incognito ("no-session") terminal routed to an SSH execution host must leave no durable trace
// on the remote. The relay owns no scrollback file (output.log/checkpoint live only in the local
// daemon's HistoryManager), so the shell's own command-history file is the sole on-disk leak this
// path can produce. These are behavioral checks on the spawn env and the filesystem — not source
// greps — mirroring the daemon's withHistoryIsolation incognito contract.
describe('relay incognito shell-history suppression', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  const worktreeId = 'r::/remote/incognito-worktree'
  const scopedHistoryFile = join(
    homedir(),
    '.orca-remote',
    'terminal-history',
    `${hashWorktreeId(worktreeId)}-zsh_history`
  )
  // injectRelayHistoryEnv honours an inherited HISTFILE and short-circuits; clear it so the
  // non-incognito contrast actually reaches the write path it is meant to prove.
  let savedHistfile: string | undefined

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest(mocks))
    savedHistfile = process.env.HISTFILE
    delete process.env.HISTFILE
    rmSync(scopedHistoryFile, { force: true })
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
    rmSync(scopedHistoryFile, { force: true })
    if (savedHistfile === undefined) {
      delete process.env.HISTFILE
    } else {
      process.env.HISTFILE = savedHistfile
    }
  })

  const spawnParams = (incognito: boolean): Record<string, unknown> => ({
    cols: 80,
    rows: 24,
    worktreeId,
    historyIsolationEnabled: true,
    ...(incognito ? { incognito: true } : {}),
    env: { SHELL: '/bin/zsh' }
  })

  const lastSpawnEnv = (): Record<string, string> =>
    mocks.mockPtySpawn.mock.calls.at(-1)?.[2]?.env as Record<string, string>

  it('forces every shell history knob off and mints no history file', async () => {
    await dispatcher.callRequest('pty.spawn', spawnParams(true))

    const spawnEnv = lastSpawnEnv()
    expect(spawnEnv.HISTFILE).toBe('/dev/null')
    expect(spawnEnv.HISTSIZE).toBe('0')
    expect(spawnEnv.ORCA_INCOGNITO).toBe('1')
    // macOS /etc/zshrc clobbers HISTFILE; the wrapper restores it from ORCA_HISTFILE, so without
    // this a zsh pane records to ~/.zsh_history despite HISTFILE=/dev/null.
    expect(spawnEnv.ORCA_HISTFILE).toBe('/dev/null')
    // fish ignores HISTFILE entirely and keys off its own store; private mode is the only lever.
    expect(spawnEnv.fish_private_mode).toBe('1')
    expect(existsSync(scopedHistoryFile)).toBe(false)
  })

  it('still mints the scoped history file when the same spawn is not incognito (gate is load-bearing)', async () => {
    await dispatcher.callRequest('pty.spawn', spawnParams(false))

    const spawnEnv = lastSpawnEnv()
    expect(spawnEnv.HISTFILE).toBe(scopedHistoryFile)
    expect(spawnEnv.ORCA_INCOGNITO).toBeUndefined()
    expect(existsSync(scopedHistoryFile)).toBe(true)
  })

  it('re-suppresses history when an incognito pane is revived', async () => {
    await dispatcher.callRequest('pty.spawn', spawnParams(true))
    const state = (await dispatcher.callRequest('pty.serialize', { ids: [PTY_1] })) as string
    await handler.dispose({ waitForPhysicalExit: false })
    mocks.mockPtySpawn.mockClear()
    rmSync(scopedHistoryFile, { force: true })
    dispatcher = createMockDispatcher()
    handler = createTestPtyHandler(dispatcher)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await dispatcher.callRequest('pty.revive', { state })
    } finally {
      killSpy.mockRestore()
    }

    const revivedEnv = lastSpawnEnv()
    expect(revivedEnv.HISTFILE).toBe('/dev/null')
    expect(revivedEnv.ORCA_HISTFILE).toBe('/dev/null')
    expect(revivedEnv.fish_private_mode).toBe('1')
    expect(revivedEnv.ORCA_INCOGNITO).toBe('1')
    expect(existsSync(scopedHistoryFile)).toBe(false)
  })
})
