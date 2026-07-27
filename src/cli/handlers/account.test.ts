import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  deleteKeychainMock,
  readKeychainMock,
  resolveCliCommandMock,
  spawnMock,
  writeKeychainMock
} = vi.hoisted(() => ({
  deleteKeychainMock: vi.fn(),
  readKeychainMock: vi.fn(),
  resolveCliCommandMock: vi.fn(),
  spawnMock: vi.fn(),
  writeKeychainMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawn: spawnMock
}))
vi.mock('../../main/claude-accounts/keychain', () => ({
  deleteActiveClaudeKeychainCredentialsStrict: deleteKeychainMock,
  readActiveClaudeKeychainCredentialsStrict: readKeychainMock,
  writeActiveClaudeKeychainCredentials: writeKeychainMock
}))
vi.mock('../../main/codex-cli/command', () => ({ resolveCliCommand: resolveCliCommandMock }))

import { ACCOUNT_HANDLERS } from './account'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import { getCmdExePath } from '../../main/win32-utils'

function successfulChild(): EventEmitter {
  const child = new EventEmitter()
  queueMicrotask(() => child.emit('exit', 0))
  return child
}

function accountState(email: string) {
  return {
    accounts: [{ id: 'account-1', email }],
    activeAccountId: 'account-1',
    activeAccountIdsByRuntime: { host: 'account-1', wsl: {} }
  }
}

describe('account CLI handlers', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const originalElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE
  const callMock = vi.fn()
  const client = { call: callMock } as unknown as RuntimeClient
  let logSpy: ReturnType<typeof vi.spyOn>

  function context(agent: string, json = false): HandlerContext {
    return {
      client,
      cwd: process.cwd(),
      flags: new Map([['agent', agent]]),
      json,
      rawArgs: []
    }
  }

  beforeEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    spawnMock.mockReset().mockImplementation(() => successfulChild())
    resolveCliCommandMock.mockReset().mockImplementation((command: string) => command)
    readKeychainMock.mockReset().mockResolvedValue(null)
    deleteKeychainMock.mockReset().mockResolvedValue(undefined)
    writeKeychainMock.mockReset().mockResolvedValue(undefined)
    callMock.mockReset().mockImplementation((method: string) =>
      Promise.resolve({
        id: 'test',
        ok: true,
        result: accountState(
          method.includes('Claude') ? 'claude@example.com' : 'codex@example.com'
        ),
        _meta: { runtimeId: 'test-runtime' }
      })
    )
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    process.env.ELECTRON_RUN_AS_NODE = '1'
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    logSpy.mockRestore()
    if (originalElectronRunAsNode === undefined) {
      delete process.env.ELECTRON_RUN_AS_NODE
    } else {
      process.env.ELECTRON_RUN_AS_NODE = originalElectronRunAsNode
    }
  })

  it('uses Codex device auth and keeps JSON stdout clean', async () => {
    await ACCOUNT_HANDLERS['account add'](context('codex', true))

    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      ['login', '--device-auth'],
      expect.objectContaining({
        stdio: ['inherit', process.stderr, 'inherit'],
        env: expect.objectContaining({ CODEX_HOME: expect.any(String) })
      })
    )
    const spawnOptions = spawnMock.mock.calls[0]?.[2]
    expect(spawnOptions.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(existsSync(spawnOptions.env.CODEX_HOME)).toBe(false)
    expect(callMock).toHaveBeenCalledWith('accounts.addCodexFromHome', {
      sourceHome: spawnOptions.env.CODEX_HOME
    })
  })

  it('routes Windows package-manager shims through the safe cmd launcher', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    resolveCliCommandMock.mockReturnValue('C:\\tools\\codex.cmd')

    await ACCOUNT_HANDLERS['account add'](context('codex'))

    expect(spawnMock).toHaveBeenCalledWith(
      getCmdExePath(),
      ['/d', '/c', 'C:\\tools\\codex.cmd', 'login', '--device-auth'],
      expect.objectContaining({ stdio: ['inherit', 'inherit', 'inherit'] })
    )
  })

  it('removes scoped Claude credentials and restores the legacy Keychain item', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    readKeychainMock.mockResolvedValue('legacy-credentials')

    await ACCOUNT_HANDLERS['account add'](context('claude'))

    const configDir = spawnMock.mock.calls[0]?.[2].env.CLAUDE_CONFIG_DIR
    expect(deleteKeychainMock).toHaveBeenCalledWith(configDir)
    expect(writeKeychainMock).toHaveBeenCalledWith('legacy-credentials')
    expect(existsSync(configDir)).toBe(false)
  })

  it('removes the temp login dir and stops the child when interrupted mid-login', async () => {
    // Why: Node terminates on SIGINT without unwinding `finally`, so without the
    // signal guard an interrupted login strands OAuth credentials in the temp dir.
    const kill = vi.fn()
    const child = Object.assign(new EventEmitter(), { kill })
    let codexHome = ''
    spawnMock.mockImplementation((_command, _args, options: { env: Record<string, string> }) => {
      codexHome = options.env.CODEX_HOME
      return child
    })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    const pending = ACCOUNT_HANDLERS['account add'](context('codex')).catch(() => {})
    await vi.waitFor(() => expect(codexHome).not.toBe(''))
    expect(existsSync(codexHome)).toBe(true)

    const onSignal = process.listeners('SIGINT').at(-1) as (signal: NodeJS.Signals) => void
    onSignal('SIGINT')

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130))
    expect(existsSync(codexHome)).toBe(false)
    expect(kill).toHaveBeenCalledWith('SIGINT')
    expect(callMock).not.toHaveBeenCalled()

    child.emit('exit', 1)
    await pending
    exitSpy.mockRestore()
  })

  it('cleans up when an SSH hangup ends the login', async () => {
    // Why: this flow targets headless/SSH hosts, where a dropped connection
    // delivers SIGHUP — Node's default terminates without running cleanup.
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
    let codexHome = ''
    spawnMock.mockImplementation((_command, _args, options: { env: Record<string, string> }) => {
      codexHome = options.env.CODEX_HOME
      return child
    })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    const pending = ACCOUNT_HANDLERS['account add'](context('codex')).catch(() => {})
    await vi.waitFor(() => expect(codexHome).not.toBe(''))

    const onSignal = process.listeners('SIGHUP').at(-1) as (signal: NodeJS.Signals) => void
    onSignal('SIGHUP')

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(129))
    expect(existsSync(codexHome)).toBe(false)

    child.emit('exit', 1)
    await pending
    exitSpy.mockRestore()
  })

  it('waits for in-flight cleanup when a second signal arrives', async () => {
    // Why: a boolean latch lets the second signal's process.exit fire while the
    // first cleanup is still inside a Keychain call, stranding the credentials.
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    readKeychainMock.mockResolvedValue('legacy-credentials')
    let releaseKeychainDelete: (() => void) | undefined
    deleteKeychainMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolvePromise) => {
          releaseKeychainDelete = () => resolvePromise()
        })
    )
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
    let configDir = ''
    spawnMock.mockImplementation((_command, _args, options: { env: Record<string, string> }) => {
      configDir = options.env.CLAUDE_CONFIG_DIR
      return child
    })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    const pending = ACCOUNT_HANDLERS['account add'](context('claude')).catch(() => {})
    await vi.waitFor(() => expect(configDir).not.toBe(''))

    const onSigint = process.listeners('SIGINT').at(-1) as (signal: NodeJS.Signals) => void
    const onSigterm = process.listeners('SIGTERM').at(-1) as (signal: NodeJS.Signals) => void
    // Why: `rawListeners` exposes the `once` wrapper, so this fails if the handler
    // is registered with `once` — where a second Ctrl-C falls through to Node's
    // default and kills the process mid-cleanup.
    expect(process.rawListeners('SIGINT')).toContain(onSigint)

    onSigint('SIGINT')
    await vi.waitFor(() => expect(deleteKeychainMock).toHaveBeenCalledWith(configDir))
    onSigterm('SIGTERM')
    await new Promise((resolvePromise) => setImmediate(resolvePromise))

    expect(exitSpy).not.toHaveBeenCalled()
    expect(writeKeychainMock).not.toHaveBeenCalled()
    expect(existsSync(configDir)).toBe(true)

    releaseKeychainDelete?.()
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled())
    expect(writeKeychainMock).toHaveBeenCalledWith('legacy-credentials')
    expect(existsSync(configDir)).toBe(false)

    child.emit('exit', 1)
    await pending
    exitSpy.mockRestore()
  })

  it('warns that the account may already be registered when interrupted mid-RPC', async () => {
    // Why: the runtime finishes the add independently of this process, so an
    // interrupt after sign-in cannot honestly be reported as "not added".
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit('exit', 0))
      return child
    })
    callMock.mockImplementation(() => new Promise(() => {}))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    void ACCOUNT_HANDLERS['account add'](context('codex')).catch(() => {})
    await vi.waitFor(() => expect(callMock).toHaveBeenCalled())

    const onSignal = process.listeners('SIGINT').at(-1) as (signal: NodeJS.Signals) => void
    onSignal('SIGINT')

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('may still have been registered'))
    warnSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it('rejects `--agent` with no value instead of defaulting to Claude', async () => {
    // Why: the parser turns a valueless flag into boolean true, so a silent
    // default would run a full OAuth login for the wrong provider.
    await expect(
      ACCOUNT_HANDLERS['account add']({ ...context('claude'), flags: new Map([['agent', true]]) })
    ).rejects.toThrow('Missing a value for --agent')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('marks an account selected for WSL as active in human output', async () => {
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: {
        claude: {
          accounts: [{ id: 'claude-wsl', email: 'claude@example.com' }],
          activeAccountId: null,
          activeAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'claude-wsl' } }
        },
        codex: { accounts: [], activeAccountId: null }
      },
      _meta: { runtimeId: 'test-runtime' }
    })

    await ACCOUNT_HANDLERS['account list']({ ...context('claude'), flags: new Map() })

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('claude@example.com (active)'))
  })

  it('lists accounts without forcing a provider usage refresh', async () => {
    // Why: the forced lane bypasses the poll throttle and costs one serial
    // round-trip per managed account, and this output shows no usage numbers.
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: {
        claude: { accounts: [], activeAccountId: null },
        codex: { accounts: [], activeAccountId: null }
      },
      _meta: { runtimeId: 'test-runtime' }
    })

    await ACCOUNT_HANDLERS['account list']({ ...context('claude'), flags: new Map() })

    expect(callMock).toHaveBeenCalledWith('accounts.list', { refreshUsage: false })
  })
})
