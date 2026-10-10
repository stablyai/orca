import type * as NodeCliCommandResolutionModule from '../../shared/node-cli-command-resolution'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { delimiter } from 'node:path'
import type * as NodeFs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  deleteKeychainMock,
  getVersionManagerBinPathsMock,
  readKeychainMock,
  resolveCliCommandMock,
  rmSyncMock,
  spawnMock,
  stdioForWindowsInteractiveChildMock,
  writeKeychainMock
} = vi.hoisted(() => ({
  deleteKeychainMock: vi.fn(),
  getVersionManagerBinPathsMock: vi.fn(),
  readKeychainMock: vi.fn(),
  resolveCliCommandMock: vi.fn(),
  rmSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  stdioForWindowsInteractiveChildMock: vi.fn(),
  writeKeychainMock: vi.fn()
}))

// Why: keep real temp-dir cleanup by default so leak assertions stay honest,
// while allowing deterministic Windows EBUSY coverage.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  rmSyncMock.mockImplementation(actual.rmSync)
  return { ...actual, rmSync: rmSyncMock }
})

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
// Why importOriginal: withCliRuntimeOnPath is a pure filesystem-probing helper,
// and the PATH assertions below are only meaningful against the real one.
vi.mock('../../shared/node-cli-command-resolution', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeCliCommandResolutionModule>()),
  getVersionManagerBinPaths: getVersionManagerBinPathsMock,
  resolveCliCommand: resolveCliCommandMock
}))
vi.mock('../../shared/windows-console-input', () => ({
  stdioForWindowsInteractiveChild: stdioForWindowsInteractiveChildMock
}))

import { ACCOUNT_HANDLERS } from './account'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import {
  getCmdExePath,
  WINDOWS_BATCH_UNSAFE_ARGUMENTS_ERROR,
  WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL
} from '../../shared/windows-batch-spawn'
import {
  ACCOUNT_IMPORT_RUNTIME_CAPABILITY,
  CLAUDE_SIGN_IN_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'

function successfulChild(): EventEmitter {
  const child = new EventEmitter()
  queueMicrotask(() => child.emit('exit', 0))
  return child
}

// Why: identify the handler under test by set difference, not by position —
// `.at(-1)` picks up any listener a later registration appends (vitest installs
// its own once-wrapped SIGINT teardown), which made assertions flake.
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
    // Why: a test run inside a real distro carries WSL_DISTRO_NAME, which would
    // leak WSL attribution into every faked-win32 add below.
    delete process.env.WSL_DISTRO_NAME
    delete process.env.ORCA_CLI_WSL_DISTRO
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    logSpy.mockRestore()
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

  it('keeps JSON login prompts off the CLI stdout envelope when console fds are attached', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    stdioForWindowsInteractiveChildMock.mockReturnValue({
      stdio: [11, process.stderr, 'inherit'],
      dispose: vi.fn()
    })

    await ACCOUNT_HANDLERS['account add'](context('codex', true))

    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      ['login', '--device-auth'],
      expect.objectContaining({ stdio: [11, process.stderr, 'inherit'] })
    )
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

  it('launches a Windows shim installed under Program Files (x86)', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const shim = 'C:\\Program Files (x86)\\nodejs\\codex.cmd'
    resolveCliCommandMock.mockReturnValue(shim)

    await ACCOUNT_HANDLERS['account add'](context('codex'))

    expect(spawnMock).toHaveBeenCalledWith(
      getCmdExePath(),
      ['/d', '/c', shim, 'login', '--device-auth'],
      expect.anything()
    )
  })

  it('explains an unspawnable Windows shim path instead of leaking the error sentinel', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    resolveCliCommandMock.mockReturnValue('C:\\Users\\A&B\\codex.cmd')

    const error = await ACCOUNT_HANDLERS['account add'](context('codex')).catch(
      (thrown: unknown) => thrown
    )

    expect(spawnMock).not.toHaveBeenCalled()
    const message = error instanceof Error ? error.message : String(error)
    expect(message).not.toBe(WINDOWS_BATCH_UNSAFE_ARGUMENTS_ERROR)
    expect(message).toContain('C:\\Users\\A&B\\codex.cmd')
    expect(message).toContain(WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL)
  })

  it('adds version-manager Node paths to the login child environment', async () => {
    const nodeBin = '/home/test/.nvm/versions/node/v22.0.0/bin'
    getVersionManagerBinPathsMock.mockReturnValue([nodeBin])

    await ACCOUNT_HANDLERS['account add'](context('codex'))

    const path = spawnMock.mock.calls[0]?.[2].env.PATH as string
    expect(path.split(delimiter)[0]).toBe(nodeBin)
  })

  it('updates the effective Windows PATH regardless of native environment casing', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    process.env.Path = 'C:\\stale'
    const nodeBin = 'C:\\Users\\test\\.volta\\bin'
    const effectivePathBefore = process.env.PATH ?? process.env.Path ?? ''
    getVersionManagerBinPathsMock.mockReturnValue([nodeBin])

    await ACCOUNT_HANDLERS['account add'](context('codex'))

    const env = spawnMock.mock.calls[0]?.[2].env as NodeJS.ProcessEnv
    const pathValues = Object.entries(env)
      .filter(([key]) => key.toLowerCase() === 'path')
      .map(([, value]) => value)
    expect(pathValues).toContain(`${nodeBin}${delimiter}${effectivePathBefore}`)
  })

  it('runs login in the final profile and never reads, writes or cleans up Keychain credentials', async () => {
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
      // Why: a Linux CLI talks to a Linux runtime whose accounts are host-lane;
      // WSL_DISTRO_NAME there names the CLI's own environment, not a target lane.
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      process.env.WSL_DISTRO_NAME = 'Ubuntu-22.04'
      process.env.ORCA_CLI_WSL_DISTRO = 'Ubuntu-22.04'

      await ACCOUNT_HANDLERS['account add'](context('codex'))

      const sourceHome = spawnMock.mock.calls[0]?.[2].env.CODEX_HOME
      expect(callMock).toHaveBeenCalledWith('accounts.addCodexFromHome', { sourceHome })
    }
  )

  it('waits for physical child close before removing interrupted login credentials', async () => {
    // Why: deleting first lets the still-live login recreate credentials afterward.
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
    // Why: this flow targets headless/SSH hosts, where a dropped connection
    // delivers SIGHUP — Node's default terminates without running cleanup.
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
    // Why: the runtime finishes the add independently of this process, so an
    // interrupt after sign-in cannot honestly be reported as "not added".
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit('exit', 0))
      return child
    })
    // Why: only the registration RPC hangs — the preflight must still resolve.
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
          : new Promise(() => {})
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const listenersBefore = process.listeners('SIGINT')

    void ACCOUNT_HANDLERS['account add'](context('codex')).catch(() => {})
    await vi.waitFor(() =>
      expect(callMock).toHaveBeenCalledWith('accounts.addCodexFromHome', expect.anything())
    )

    newSignalListener('SIGINT', listenersBefore)('SIGINT')

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('may still have been registered'))
    warnSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it('fails before the login when the runtime is unreachable', async () => {
    // Why: discovering a dead runtime after sign-in wastes a full OAuth round trip.
    callMock.mockRejectedValue(new Error('runtime not running'))

    await expect(ACCOUNT_HANDLERS['account add'](context('codex'))).rejects.toThrow(
      'runtime not running'
    )
    expect(callMock).toHaveBeenCalledWith('status.get')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('still adds Codex through an older host that advertises only the retired import capability', async () => {
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: { capabilities: [ACCOUNT_IMPORT_RUNTIME_CAPABILITY] },
      _meta: { runtimeId: 'test-runtime' }
    })
    spawnMock.mockImplementation(() => {
      throw new Error('stop after the capability gate')
    })

    await expect(ACCOUNT_HANDLERS['account add'](context('codex'))).rejects.toThrow()
    expect(spawnMock).toHaveBeenCalled()
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
      // Why: account commands are pinned to the local runtime, so honoring these
      // silently would register the account on the wrong host.
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
      // Why: listing is read-only, but answering with the LOCAL machine's accounts
      // when the user named a remote host is the specific wrong answer they'd act on.
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
    // Why: cleanup runs in a `finally`, so an unguarded rejection there replaces
    // the error that actually explains why the add failed.
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

  it('does not touch a locked Keychain while the CLI signs in', async () => {
    readKeychainMock.mockRejectedValue(new Error('locked'))
    deleteKeychainMock.mockRejectedValue(new Error('locked'))
    writeKeychainMock.mockRejectedValue(new Error('locked'))
    await ACCOUNT_HANDLERS['account add'](context('claude'))
    expect(readKeychainMock).not.toHaveBeenCalled()
    expect(deleteKeychainMock).not.toHaveBeenCalled()
    expect(writeKeychainMock).not.toHaveBeenCalled()
  })

  it('rejects `--agent` with no value instead of defaulting to Claude', async () => {
    // Why: the parser turns a valueless flag into boolean true, so a silent
    // default would run a full OAuth login for the wrong provider.
    await expect(
      ACCOUNT_HANDLERS['account add']({ ...context('claude'), flags: new Map([['agent', true]]) })
    ).rejects.toThrow(
      'Missing a value for --agent. Use `--agent claude`, `--agent codex`, `--agent opencode`, or `--agent devin`.'
    )
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

  it('tells the user which saved Claude accounts need a fresh sign-in', async () => {
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: {
        claude: {
          accounts: [
            { id: 'old', email: 'old@example.com', needsSignIn: true },
            { id: 'ok', email: 'ok@example.com' }
          ],
          activeAccountId: 'old'
        },
        codex: { accounts: [], activeAccountId: null }
      },
      _meta: { runtimeId: 'test-runtime' }
    })

    await ACCOUNT_HANDLERS['account list']({ ...context('claude'), flags: new Map() })

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '  old@example.com (active) (sign in again in Orca Settings > AI Provider Accounts)\n  ok@example.com\n'
      )
    )
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
