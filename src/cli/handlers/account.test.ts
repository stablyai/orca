import type * as NodeCliCommandResolutionModule from '../../shared/node-cli-command-resolution'
import type * as ProcessHostModule from '@orca/process-host'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import type * as NodeFs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  deleteKeychainMock,
  getVersionManagerBinPathsMock,
  readKeychainMock,
  resolveCliCommandMock,
  probeMock,
  rmSyncMock,
  spawnMock,
  stdioForWindowsInteractiveChildMock,
  writeKeychainMock
} = vi.hoisted(() => ({
  deleteKeychainMock: vi.fn(),
  getVersionManagerBinPathsMock: vi.fn(),
  readKeychainMock: vi.fn(),
  resolveCliCommandMock: vi.fn(),
  probeMock: vi.fn(),
  rmSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  stdioForWindowsInteractiveChildMock: vi.fn(),
  writeKeychainMock: vi.fn()
}))

// Use real cleanup by default so leaks remain visible; override it only for Windows EBUSY cases.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  rmSyncMock.mockImplementation(actual.rmSync)
  return { ...actual, rmSync: rmSyncMock }
})

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn()
}))
vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessHostModule>()),
  spawnProcess: (spec: ProcessSpec) =>
    spec.args?.includes('--help') ? probeMock(spec) : spawnMock(spec.program, spec.args, spec)
}))
vi.mock('../../main/claude-accounts/keychain', () => ({
  deleteActiveClaudeKeychainCredentialsStrict: deleteKeychainMock,
  readActiveClaudeKeychainCredentialsStrict: readKeychainMock,
  writeActiveClaudeKeychainCredentials: writeKeychainMock
}))
// PATH assertions must exercise the real withCliRuntimeOnPath filesystem probes.
vi.mock('../../shared/node-cli-command-resolution', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeCliCommandResolutionModule>()),
  getVersionManagerBinPaths: getVersionManagerBinPathsMock,
  resolveCliCommand: resolveCliCommandMock
}))
vi.mock('../../shared/windows-console-input', () => ({
  stdioForWindowsInteractiveChild: stdioForWindowsInteractiveChildMock
}))

import { ACCOUNT_HANDLERS } from './account'
import { REPEATED_FLAG_SEPARATOR } from '../args'
import type { HandlerContext } from '../dispatch'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import {
  ACCOUNT_IMPORT_RUNTIME_CAPABILITY,
  ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY,
  CLAUDE_SIGN_IN_RUNTIME_CAPABILITY,
  DATA_ACCOUNT_RUNTIME_CAPABILITY
} from '../../shared/account-runtime-capabilities'

function helpChild(stdout: string): EventEmitter {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() })
  queueMicrotask(() => {
    child.stdout.write(stdout)
    child.emit('exit', 0)
    child.emit('close', 0)
  })
  return child
}

function successfulChild(): EventEmitter {
  const child = new EventEmitter()
  queueMicrotask(() => child.emit('exit', 0))
  return child
}

// Diff listener sets: Vitest may append its own wrapped SIGINT listener after ours.
function newSignalListener(
  signal: NodeJS.Signals,
  before: readonly unknown[]
): (signal: NodeJS.Signals) => void {
  const added = process.listeners(signal).filter((listener) => !before.includes(listener))
  if (added.length !== 1) {
    throw new Error(`Expected 1 new ${signal} listener, found ${added.length}`)
  }
  return added[0] as (signal: NodeJS.Signals) => void
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
  const originalPathAlias = process.env.Path
  const originalWslDistroName = process.env.WSL_DISTRO_NAME
  const originalBridgeDistro = process.env.ORCA_CLI_WSL_DISTRO
  const callMock = vi.fn()
  const client = { call: callMock } as unknown as RuntimeClient
  let logSpy: ReturnType<typeof vi.spyOn>

  function context(agent: string, json = false, cwd = process.cwd()): HandlerContext {
    return {
      client,
      cwd,
      flags: new Map([['agent', agent]]),
      json,
      rawArgs: []
    }
  }

  beforeEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    spawnMock.mockReset().mockImplementation(() => successfulChild())
    stdioForWindowsInteractiveChildMock.mockReset().mockImplementation((json: boolean) => ({
      stdio: ['inherit', json ? process.stderr : 'inherit', 'inherit'],
      dispose: vi.fn()
    }))
    resolveCliCommandMock.mockReset().mockImplementation((command: string) => command)
    probeMock.mockReset()
    getVersionManagerBinPathsMock.mockReset().mockReturnValue([])
    readKeychainMock.mockReset().mockResolvedValue(null)
    deleteKeychainMock.mockReset().mockResolvedValue(undefined)
    writeKeychainMock.mockReset().mockResolvedValue(undefined)
    callMock.mockReset().mockImplementation((method: string) =>
      Promise.resolve({
        id: 'test',
        ok: true,
        result:
          method === 'status.get'
            ? {
                capabilities: [ACCOUNT_IMPORT_RUNTIME_CAPABILITY, CLAUDE_SIGN_IN_RUNTIME_CAPABILITY]
              }
            : method === 'accounts.beginClaudeSignIn'
              ? { accountId: 'draft', configDir: '/fake/final-profile', runtime: 'host' }
              : accountState(
                  method.includes('Claude') ? 'claude@example.com' : 'codex@example.com'
                ),
        _meta: { runtimeId: 'test-runtime' }
      })
    )
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    process.env.ELECTRON_RUN_AS_NODE = '1'
    // Clear real WSL attribution before simulating win32.
    delete process.env.WSL_DISTRO_NAME
    delete process.env.ORCA_CLI_WSL_DISTRO
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    vi.restoreAllMocks()
    if (originalElectronRunAsNode === undefined) {
      delete process.env.ELECTRON_RUN_AS_NODE
    } else {
      process.env.ELECTRON_RUN_AS_NODE = originalElectronRunAsNode
    }
    if (originalPathAlias === undefined) {
      delete process.env.Path
    } else {
      process.env.Path = originalPathAlias
    }
    if (originalBridgeDistro === undefined) {
      delete process.env.ORCA_CLI_WSL_DISTRO
    } else {
      process.env.ORCA_CLI_WSL_DISTRO = originalBridgeDistro
    }
    if (originalWslDistroName === undefined) {
      delete process.env.WSL_DISTRO_NAME
    } else {
      process.env.WSL_DISTRO_NAME = originalWslDistroName
    }
  })

  it('falls back to OpenCode when opencode2 cannot be spawned', async () => {
    const supportedCommand = 'opencode'
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: { capabilities: [DATA_ACCOUNT_RUNTIME_CAPABILITY] },
      _meta: { runtimeId: 'test-runtime' }
    })
    resolveCliCommandMock.mockImplementation((command: string) => `/tools/${command}`)
    probeMock.mockImplementation(({ program }) => {
      if (program !== `/tools/${supportedCommand}`) {
        throw new Error('ENOENT')
      }
      return helpChild('--standalone  Run with a private server instead of the background service')
    })
    await ACCOUNT_HANDLERS['account add'](context('opencode', true))
    expect(probeMock.mock.calls.map(([spec]) => spec.program)).toEqual([
      '/tools/opencode2',
      '/tools/opencode'
    ])
    const [command, args, options] = spawnMock.mock.calls[0]
    expect(command).toBe(`/tools/${supportedCommand}`)
    expect(args).toEqual(['auth', 'login', '--standalone'])
    expect(probeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        args: ['auth', 'login', '--help'],
        env: options.env
      })
    )
    expect(options.env.OPENCODE_DB).toBe('opencode.db')
    expect(existsSync(options.env.XDG_DATA_HOME)).toBe(false)
    expect(callMock).toHaveBeenLastCalledWith('accounts.addDataFromHome', {
      provider: 'opencode',
      sourceDataHome: options.env.XDG_DATA_HOME,
      label: 'opencode'
    })
  })

  it('passes the same original Windows launcher to the probe and login', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    callMock.mockResolvedValue({ result: { capabilities: [DATA_ACCOUNT_RUNTIME_CAPABILITY] } })
    const launcher = String.raw`C:\Users\A&B\npm tools\opencode2.cmd`
    resolveCliCommandMock.mockReturnValue(launcher)
    probeMock.mockImplementation(() => helpChild('--standalone'))

    await ACCOUNT_HANDLERS['account add'](context('opencode', true))

    expect(probeMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ program: launcher, args: ['auth', 'login', '--help'] })
    )
    const probeEnv = probeMock.mock.calls[0][0].env
    expect(spawnMock).toHaveBeenCalledExactlyOnceWith(
      launcher,
      ['auth', 'login', '--standalone'],
      expect.objectContaining({ env: probeEnv, stdio: ['inherit', process.stderr, 'inherit'] })
    )
    expect(existsSync(probeEnv.XDG_DATA_HOME)).toBe(false)
    expect(callMock).toHaveBeenLastCalledWith('accounts.addDataFromHome', {
      provider: 'opencode',
      sourceDataHome: probeEnv.XDG_DATA_HOME,
      label: 'opencode'
    })
  })

  it.each(['v1', 'missing'])(
    'gives installation guidance after %s candidates without altering generic launchers',
    async (fallback) => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      callMock.mockResolvedValue({ result: { capabilities: [DATA_ACCOUNT_RUNTIME_CAPABILITY] } })
      resolveCliCommandMock.mockImplementation((name: string) => `C:\\tools\\${name}.cmd`)
      probeMock.mockImplementation(() => {
        if (fallback === 'missing') {
          throw new Error('ENOENT')
        }
        return helpChild('Usage: opencode auth login [url]')
      })
      const failure = await ACCOUNT_HANDLERS['account add'](context('opencode', true)).catch(
        (error: unknown) => error
      )
      expect(failure).toBeInstanceOf(RuntimeClientError)
      if (!(failure instanceof RuntimeClientError)) {
        throw new Error('Expected account-add failure')
      }
      expect(probeMock).toHaveBeenCalledTimes(2)
      expect(spawnMock).not.toHaveBeenCalled()
      expect(callMock.mock.calls.map(([method]) => method)).toEqual(['status.get'])
      expect(existsSync(probeMock.mock.calls[0][0].env.XDG_DATA_HOME)).toBe(false)
      expect(failure.message).toContain(
        String.raw`npm install --prefix C:\tools\orca-opencode2 @opencode/cli`
      )
      expect(failure.message).toContain('without changing your generic opencode launcher')
      expect(failure.message).not.toContain('Usage:')
    }
  )

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

  it('passes Windows console device handles to the login child instead of inheriting Electron stdio', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const dispose = vi.fn()
    stdioForWindowsInteractiveChildMock.mockReturnValue({
      stdio: [11, 'inherit', 'inherit'],
      dispose
    })

    await ACCOUNT_HANDLERS['account add'](context('codex'))

    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      ['login', '--device-auth'],
      expect.objectContaining({ stdio: [11, 'inherit', 'inherit'] })
    )
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('disposes the Windows console input fd when spawn throws synchronously', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const dispose = vi.fn()
    stdioForWindowsInteractiveChildMock.mockReturnValue({
      stdio: [11, 'inherit', 'inherit'],
      dispose
    })
    spawnMock.mockImplementationOnce(() => {
      throw new Error('invalid stdio')
    })

    await expect(ACCOUNT_HANDLERS['account add'](context('codex'))).rejects.toThrow('invalid stdio')

    expect(dispose).toHaveBeenCalledOnce()
  })

  it('forwards Windows form text literally through the process launcher', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    callMock.mockResolvedValue({ result: { capabilities: [DATA_ACCOUNT_RUNTIME_CAPABILITY] } })
    resolveCliCommandMock.mockImplementation((command: string) => `C:\\tools\\${command}.cmd`)
    probeMock.mockImplementation(() => helpChild('--standalone'))
    const answer = 'instance URL=https://gitlab.example.test/a%20b?x="quoted"&y=a=b!'
    await ACCOUNT_HANDLERS['account add']({
      ...context('opencode', true),
      flags: new Map([
        ['agent', 'opencode'],
        ['answer', answer]
      ])
    })
    expect(spawnMock.mock.calls[0][1]).toEqual([
      'auth',
      'login',
      '--answer',
      answer,
      '--standalone'
    ])
    expect(callMock).toHaveBeenLastCalledWith('accounts.addDataFromHome', expect.anything())
  })

  it('runs login in the final profile without accessing a locked Keychain', async () => {
    readKeychainMock.mockRejectedValue(new Error('locked'))
    deleteKeychainMock.mockRejectedValue(new Error('locked'))
    writeKeychainMock.mockRejectedValue(new Error('locked'))
    await ACCOUNT_HANDLERS['account add'](context('claude'))
    expect(spawnMock.mock.calls[0]?.[2].env.CLAUDE_CONFIG_DIR).toBe('/fake/final-profile')
    expect(callMock).toHaveBeenCalledWith(
      'accounts.finishClaudeSignIn',
      { accountId: 'draft', runtime: 'host', wslDistro: undefined },
      { timeoutMs: 300000 }
    )
    expect(readKeychainMock).not.toHaveBeenCalled()
    expect(writeKeychainMock).not.toHaveBeenCalled()
    expect(deleteKeychainMock).not.toHaveBeenCalled()
  })

  it('attributes a Codex account added through the WSL bridge to the cwd distro', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    await ACCOUNT_HANDLERS['account add'](
      context('codex', false, String.raw`\\wsl$\Ubuntu\home\user`)
    )

    const sourceHome = spawnMock.mock.calls[0]?.[2].env.CODEX_HOME
    expect(callMock).toHaveBeenCalledWith('accounts.addCodexFromHome', {
      sourceHome,
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
  })

  it('uses the explicit bridge distro over an ambient environment or another distro cwd', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    process.env.WSL_DISTRO_NAME = 'stale-Windows-value'
    process.env.ORCA_CLI_WSL_DISTRO = 'Debian'

    await ACCOUNT_HANDLERS['account add'](
      context('claude', false, String.raw`\\wsl.localhost\Ubuntu-22.04\home\user`)
    )

    expect(callMock).toHaveBeenCalledWith(
      'accounts.beginClaudeSignIn',
      expect.objectContaining({ runtime: 'wsl', wslDistro: 'Debian' }),
      { timeoutMs: 300000 }
    )
  })

  it.each(['claude', 'codex'])(
    'attributes %s from a Windows mount to the bridge distro',
    async (agent) => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      process.env.ORCA_CLI_WSL_DISTRO = 'Ubuntu Work'
      await ACCOUNT_HANDLERS['account add'](context(agent, false, String.raw`C:\work with spaces`))
      expect(
        callMock.mock.calls.some(
          ([method, params]) =>
            method ===
              (agent === 'claude' ? 'accounts.beginClaudeSignIn' : 'accounts.addCodexFromHome') &&
            params.wslDistro === 'Ubuntu Work'
        )
      ).toBe(true)
    }
  )

  it('ignores an ambient WSL distro in a native Windows account add', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    process.env.WSL_DISTRO_NAME = 'stale-Windows-value'
    await ACCOUNT_HANDLERS['account add'](context('codex', false, String.raw`C:\work`))
    const sourceHome = spawnMock.mock.calls[0]?.[2].env.CODEX_HOME
    expect(callMock).toHaveBeenCalledWith('accounts.addCodexFromHome', { sourceHome })
  })

  it.each(['linux', 'darwin'])(
    'keeps host attribution when the CLI runs on %s',
    async (platform) => {
      // Linux runtimes use host-lane accounts even when the CLI itself runs in WSL.
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      process.env.WSL_DISTRO_NAME = 'Ubuntu-22.04'
      process.env.ORCA_CLI_WSL_DISTRO = 'Ubuntu-22.04'

      await ACCOUNT_HANDLERS['account add'](context('codex'))

      const sourceHome = spawnMock.mock.calls[0]?.[2].env.CODEX_HOME
      expect(callMock).toHaveBeenCalledWith('accounts.addCodexFromHome', { sourceHome })
    }
  )

  it('waits for physical child close before removing interrupted login credentials', async () => {
    // A live login can recreate credentials after cleanup; wait for close before deleting them.
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const kill = vi.fn()
    const child = Object.assign(new EventEmitter(), { kill })
    let codexHome = ''
    spawnMock.mockImplementation((_command, _args, options: { env: Record<string, string> }) => {
      codexHome = options.env.CODEX_HOME
      return child
    })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const listenersBefore = process.listeners('SIGINT')

    const pending = ACCOUNT_HANDLERS['account add'](context('codex')).catch(() => {})
    await vi.waitFor(() => expect(codexHome).not.toBe(''))
    expect(existsSync(codexHome)).toBe(true)

    newSignalListener('SIGINT', listenersBefore)('SIGINT')

    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith('SIGINT'))
    expect(exitSpy).not.toHaveBeenCalled()
    expect(existsSync(codexHome)).toBe(true)

    child.emit('exit', 1)
    child.emit('close', 1)
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130))
    expect(existsSync(codexHome)).toBe(false)
    expect(callMock).not.toHaveBeenCalledWith('accounts.addCodexFromHome', expect.anything())

    await pending
    exitSpy.mockRestore()
  })

  it('cleans up when an SSH hangup ends the login', async () => {
    // Node's default SIGHUP exit would bypass cleanup when an SSH connection drops.
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
    let codexHome = ''
    spawnMock.mockImplementation((_command, _args, options: { env: Record<string, string> }) => {
      codexHome = options.env.CODEX_HOME
      return child
    })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const listenersBefore = process.listeners('SIGHUP')

    const pending = ACCOUNT_HANDLERS['account add'](context('codex')).catch(() => {})
    await vi.waitFor(() => expect(codexHome).not.toBe(''))

    newSignalListener('SIGHUP', listenersBefore)('SIGHUP')

    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGHUP'))
    expect(exitSpy).not.toHaveBeenCalled()
    expect(existsSync(codexHome)).toBe(true)

    child.emit('exit', 1)
    child.emit('close', 1)
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(129))
    expect(existsSync(codexHome)).toBe(false)

    await pending
    exitSpy.mockRestore()
  })

  it('warns that the account may already be registered when interrupted mid-RPC', async () => {
    // Registration continues at the runtime after the CLI is interrupted.
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit('exit', 0))
      return child
    })
    let rejectRegistration: ((error: Error) => void) | undefined
    const registration = new Promise<never>((_resolve, reject) => {
      rejectRegistration = reject
    })
    // Only registration waits; preflight must still resolve.
    callMock.mockImplementation((method: string) =>
      method === 'status.get'
        ? Promise.resolve({
            id: 'test',
            ok: true,
            result: {
              capabilities: [ACCOUNT_IMPORT_RUNTIME_CAPABILITY, CLAUDE_SIGN_IN_RUNTIME_CAPABILITY]
            },
            _meta: { runtimeId: 'test-runtime' }
          })
        : method === 'accounts.list'
          ? Promise.resolve({
              id: 'test',
              ok: true,
              result: { claude: accountState('c@e.com'), codex: accountState('x@e.com') },
              _meta: { runtimeId: 'test-runtime' }
            })
          : registration
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const listenersBefore = process.listeners('SIGINT')

    const pending = ACCOUNT_HANDLERS['account add'](context('codex')).catch(() => {})
    try {
      await vi.waitFor(() =>
        expect(callMock).toHaveBeenCalledWith('accounts.addCodexFromHome', expect.anything())
      )

      newSignalListener('SIGINT', listenersBefore)('SIGINT')

      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130))
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('may still have been registered')
      )
    } finally {
      rejectRegistration?.(new Error('finish interrupted registration'))
      await pending
      warnSpy.mockRestore()
      exitSpy.mockRestore()
    }
    expect(process.listeners('SIGINT')).toEqual(listenersBefore)
  })

  it('fails before the login when the runtime is unreachable', async () => {
    callMock.mockRejectedValue(new Error('runtime not running'))

    await expect(ACCOUNT_HANDLERS['account add'](context('codex'))).rejects.toThrow(
      'runtime not running'
    )
    expect(callMock).toHaveBeenCalledWith('status.get')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('adds Codex through an older host that advertises only the retired import capability', async () => {
    callMock.mockResolvedValueOnce({
      id: 'test',
      ok: true,
      result: { capabilities: [ACCOUNT_IMPORT_RUNTIME_CAPABILITY] },
      _meta: { runtimeId: 'test-runtime' }
    })

    await ACCOUNT_HANDLERS['account add'](context('codex'))

    const sourceHome = spawnMock.mock.calls[0]?.[2].env.CODEX_HOME
    expect(callMock).toHaveBeenCalledWith('accounts.addCodexFromHome', { sourceHome })
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('codex@example.com'))
  })

  it.each(['claude', 'codex'] as const)(
    'refuses %s login before spawning when its capability is absent',
    async (agent) => {
      callMock.mockResolvedValue({
        id: 'test',
        ok: true,
        result: { capabilities: [] },
        _meta: { runtimeId: 'test-runtime' }
      })

      await expect(ACCOUNT_HANDLERS['account add'](context(agent))).rejects.toThrow(
        'The running Orca runtime is too old to add accounts from the CLI.'
      )
      expect(callMock).toHaveBeenCalledOnce()
      expect(callMock).toHaveBeenCalledWith('status.get')
      expect(spawnMock).not.toHaveBeenCalled()
    }
  )

  it.each(['environment', 'pairing-code'])(
    'rejects --%s instead of silently ignoring it',
    async (flag) => {
      await expect(
        ACCOUNT_HANDLERS['account add']({
          ...context('codex'),
          flags: new Map<string, string | boolean>([
            ['agent', 'codex'],
            [flag, 'homelab']
          ])
        })
      ).rejects.toThrow(`\`--${flag}\` does not retarget`)
      expect(spawnMock).not.toHaveBeenCalled()
    }
  )

  it.each(['environment', 'pairing-code'])(
    'rejects --%s on `account list` instead of listing the local host',
    async (flag) => {
      await expect(
        ACCOUNT_HANDLERS['account list']({
          ...context('claude'),
          flags: new Map<string, string | boolean>([[flag, 'homelab']])
        })
      ).rejects.toThrow(`\`--${flag}\` does not retarget`)
      expect(callMock).not.toHaveBeenCalled()
    }
  )

  it('keeps the original add error when cleanup also fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    rmSyncMock.mockImplementationOnce(() => {
      throw new Error('EBUSY: resource busy or locked')
    })
    callMock.mockImplementation((method: string) =>
      method === 'status.get'
        ? Promise.resolve({
            id: 'test',
            ok: true,
            result: {
              capabilities: [ACCOUNT_IMPORT_RUNTIME_CAPABILITY, CLAUDE_SIGN_IN_RUNTIME_CAPABILITY]
            },
            _meta: { runtimeId: 'test-runtime' }
          })
        : method === 'accounts.list'
          ? Promise.resolve({
              id: 'test',
              ok: true,
              result: { claude: accountState('c@e.com'), codex: accountState('x@e.com') },
              _meta: { runtimeId: 'test-runtime' }
            })
          : Promise.reject(new Error('registration rejected by runtime'))
    )

    await expect(ACCOUNT_HANDLERS['account add'](context('codex'))).rejects.toThrow(
      'registration rejected by runtime'
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to clean up the temporary login directory'),
      expect.any(Error)
    )
    warnSpy.mockRestore()
  })

  it('fails a successful add when the temporary credentials cannot be removed', async () => {
    rmSyncMock.mockImplementationOnce(() => {
      throw new Error('EBUSY: resource busy or locked')
    })

    await expect(ACCOUNT_HANDLERS['account add'](context('codex', true))).rejects.toThrow('EBUSY')
    expect(logSpy).not.toHaveBeenCalled()
  })

  it.each(['claude', 'codex'])(
    'rejects OpenCode login flags for %s before login',
    async (agent) => {
      await expect(
        ACCOUNT_HANDLERS['account add']({
          ...context(agent),
          flags: new Map([
            ['agent', agent],
            ['method', 'device']
          ])
        })
      ).rejects.toThrow('only supported with --agent opencode')
      expect(callMock).not.toHaveBeenCalled()
      expect(spawnMock).not.toHaveBeenCalled()
    }
  )

  it('keeps OpenCode form answer values out of the login failure message', async () => {
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: { capabilities: [DATA_ACCOUNT_RUNTIME_CAPABILITY] },
      _meta: { runtimeId: 'test-runtime' }
    })
    resolveCliCommandMock.mockImplementation((command: string) => `/tools/${command}`)
    probeMock.mockImplementation(() => helpChild('--standalone'))
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('exit', 1))
      return child
    })
    const failure = ACCOUNT_HANDLERS['account add']({
      ...context('opencode'),
      flags: new Map([
        ['agent', 'opencode'],
        ['answer', ['token=secret-value', 'note=second-secret'].join(REPEATED_FLAG_SEPARATOR)]
      ])
    })
    await expect(failure).rejects.toThrow(
      '--answer token=<redacted> --answer note=<redacted> --standalone'
    )
    await expect(failure).rejects.not.toThrow('secret-value')
    await expect(failure).rejects.not.toThrow('second-secret')
    expect(spawnMock.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['token=secret-value', 'note=second-secret'])
    )
  })

  it('rejects `--agent` with no value instead of defaulting to Claude', async () => {
    await expect(
      ACCOUNT_HANDLERS['account add']({ ...context('claude'), flags: new Map([['agent', true]]) })
    ).rejects.toThrow(
      'Missing a value for --agent. Use `--agent claude`, `--agent codex`, `--agent opencode`, or `--agent devin`.'
    )
    expect(spawnMock).not.toHaveBeenCalled()
  })

  describe('select and rm by --account', () => {
    const antigravityAccounts = {
      accounts: [
        { id: 'agy-1', email: 'me@gmail.example', subject: 'sub-1' },
        { id: 'agy-2', email: null, subject: 'sub-2' }
      ],
      activeAccountId: 'agy-1'
    }
    const claudeAccounts = {
      accounts: [
        { id: 'claude-org-a', email: 'shared@example.com' },
        { id: 'claude-org-b', email: 'shared@example.com' }
      ],
      activeAccountId: null
    }

    function selectionContext(agent: string, account: string): HandlerContext {
      return {
        client,
        cwd: process.cwd(),
        flags: new Map([
          ['agent', agent],
          ['account', account]
        ]),
        json: false,
        rawArgs: []
      }
    }

    function mutatingCalls(): string[] {
      return callMock.mock.calls
        .map(([method]) => String(method))
        .filter((method) => /\.(select|remove|antigravitySelect|antigravityRemove)/.test(method))
    }

    beforeEach(() => {
      callMock.mockImplementation((method: string) =>
        Promise.resolve({
          id: 'test',
          ok: true,
          result:
            method === 'status.get'
              ? { capabilities: [ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY] }
              : method.startsWith('accounts.antigravity')
                ? antigravityAccounts
                : { claude: claudeAccounts, codex: { accounts: [], activeAccountId: null } },
          _meta: { runtimeId: 'test-runtime' }
        })
      )
    })

    it('selects and removes Antigravity accounts by email or subject on the host', async () => {
      await ACCOUNT_HANDLERS['account select'](selectionContext('antigravity', 'ME@gmail.example'))
      await ACCOUNT_HANDLERS['account rm'](selectionContext('antigravity', 'sub-2'))

      expect(callMock).toHaveBeenCalledWith('accounts.antigravitySelect', {
        target: { runtime: 'host' },
        accountId: 'agy-1'
      })
      expect(callMock).toHaveBeenCalledWith('accounts.antigravityRemove', {
        target: { runtime: 'host' },
        accountId: 'agy-2'
      })
    })

    it('refuses an email shared by several accounts without switching or removing', async () => {
      await expect(
        ACCOUNT_HANDLERS['account select'](selectionContext('claude', 'shared@example.com'))
      ).rejects.toThrow('claude-org-a, claude-org-b')
      await expect(
        ACCOUNT_HANDLERS['account rm'](selectionContext('claude', 'shared@example.com'))
      ).rejects.toThrow('claude-org-a, claude-org-b')
      expect(mutatingCalls()).toEqual([])
    })

    it('refuses the Antigravity system default, which its vault does not have', async () => {
      await expect(
        ACCOUNT_HANDLERS['account select'](selectionContext('antigravity', 'system'))
      ).rejects.toThrow('Antigravity has no system default')
      expect(mutatingCalls()).toEqual([])
    })

    it('refuses the Claude system default from WSL rather than resetting the Windows host', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      process.env.ORCA_CLI_WSL_DISTRO = 'Ubuntu'

      await expect(
        ACCOUNT_HANDLERS['account select'](selectionContext('claude', 'system'))
      ).rejects.toThrow('Select the Claude system default for a WSL distro in Orca Settings')
      expect(callMock).not.toHaveBeenCalled()
    })
  })
})
