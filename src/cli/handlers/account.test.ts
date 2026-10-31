import type * as NodeCliCommandResolutionModule from '../../shared/node-cli-command-resolution'
import type * as ProcessHostModule from '@orca/process-host'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { delimiter } from 'node:path'
import { PassThrough } from 'node:stream'
import type * as NodeFs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  deleteKeychainMock,
  getVersionManagerBinPathsMock,
  readKeychainMock,
  resolveCliCommandMock,
  spawnProcessMock,
  rmSyncMock,
  spawnMock,
  stdioForWindowsInteractiveChildMock,
  writeKeychainMock
} = vi.hoisted(() => ({
  deleteKeychainMock: vi.fn(),
  getVersionManagerBinPathsMock: vi.fn(),
  readKeychainMock: vi.fn(),
  resolveCliCommandMock: vi.fn(),
  spawnProcessMock: vi.fn(),
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
  spawn: spawnMock
}))
vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessHostModule>()),
  spawnProcess: spawnProcessMock
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
import type { HandlerContext } from '../dispatch'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { reportCliError } from '../cli-error'
import {
  getCmdExePath,
  WINDOWS_BATCH_UNSAFE_ARGUMENTS_ERROR,
  WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL
} from '../../shared/windows-batch-spawn'
import {
  ACCOUNT_IMPORT_RUNTIME_CAPABILITY,
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
    spawnProcessMock.mockReset()
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
    spawnProcessMock.mockImplementation(({ program }) => {
      if (program !== `/tools/${supportedCommand}`) {
        throw new Error('ENOENT')
      }
      return helpChild('--standalone  Run with a private server instead of the background service')
    })
    await ACCOUNT_HANDLERS['account add'](context('opencode', true))
    expect(spawnProcessMock.mock.calls.map(([spec]) => spec.program)).toEqual([
      '/tools/opencode2',
      '/tools/opencode'
    ])
    const [command, args, options] = spawnMock.mock.calls[0]
    expect(command).toBe(`/tools/${supportedCommand}`)
    expect(args).toEqual(['auth', 'login', '--standalone'])
    expect(spawnProcessMock).toHaveBeenLastCalledWith(
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

  it('skips a Windows candidate that the interactive login preparation cannot launch', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    callMock.mockResolvedValue({ result: { capabilities: [DATA_ACCOUNT_RUNTIME_CAPABILITY] } })
    resolveCliCommandMock.mockImplementation((command: string) =>
      command === 'opencode2' ? 'C:\\Users\\A&B\\npm\\opencode2.cmd' : 'C:\\tools\\opencode.cmd'
    )
    spawnProcessMock.mockImplementation(() => helpChild('--standalone'))

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    await ACCOUNT_HANDLERS['account add'](context('opencode', true))
    expect(warn).not.toHaveBeenCalled()
    expect(errorLog).not.toHaveBeenCalled()

    expect(spawnProcessMock).toHaveBeenCalledTimes(1)
    const [probe] = spawnProcessMock.mock.calls[0]
    expect(probe.program).toBe(getCmdExePath())
    expect(probe.args).toEqual([
      '/d',
      '/c',
      '@',
      'C:\\tools\\opencode.cmd',
      'auth',
      'login',
      '--help'
    ])
    expect(spawnMock).toHaveBeenCalledWith(
      probe.program,
      ['/d', '/c', '@', 'C:\\tools\\opencode.cmd', 'auth', 'login', '--standalone'],
      expect.objectContaining({ env: probe.env })
    )
  })

  it.each(['v1', 'missing', 'unsafe'])(
    'retains Windows preparation diagnosis with %s fallback and recovers through a safe first suffix',
    async (fallback) => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      callMock.mockResolvedValue({ result: { capabilities: [DATA_ACCOUNT_RUNTIME_CAPABILITY] } })
      const preferred = String.raw`C:\Users\A&B\AppData\Roaming\npm\opencode2.cmd`
      const generic =
        fallback === 'unsafe'
          ? String.raw`C:\Users\A&B\AppData\Roaming\npm\opencode.cmd`
          : String.raw`C:\tools\opencode.cmd`
      const resolved = new Map([
        ['opencode2', preferred],
        ['opencode', generic]
      ])
      resolveCliCommandMock.mockImplementation(
        (command: string) => resolved.get(command) ?? command
      )
      spawnProcessMock.mockImplementation(() => {
        if (fallback === 'missing') {
          throw new Error('ENOENT')
        }
        return helpChild('Usage: opencode auth login [url]\n--help Show help\n')
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
      const failure = await ACCOUNT_HANDLERS['account add'](context('opencode', true)).catch(
        (error: unknown) => error
      )
      expect(failure).toBeInstanceOf(RuntimeClientError)
      if (!(failure instanceof Error)) {
        throw new Error('Expected account-add failure')
      }
      expect(resolveCliCommandMock.mock.calls.map(([name]) => name)).toEqual([
        'opencode2',
        'opencode'
      ])
      expect(spawnProcessMock).toHaveBeenCalledTimes(fallback === 'unsafe' ? 0 : 1)
      if (fallback !== 'unsafe') {
        expect(spawnProcessMock).toHaveBeenCalledWith(
          expect.objectContaining({
            program: getCmdExePath(),
            args: ['/d', '/c', '@', generic, 'auth', 'login', '--help']
          })
        )
        expect(existsSync(spawnProcessMock.mock.calls[0][0].env.XDG_DATA_HOME)).toBe(false)
      }
      expect(spawnMock).not.toHaveBeenCalled()
      expect(callMock.mock.calls.map(([method]) => method)).toEqual(['status.get'])
      expect(warn).not.toHaveBeenCalled()
      expect(errorLog).not.toHaveBeenCalled()
      expect(logSpy).not.toHaveBeenCalled()
      reportCliError(failure, false)
      expect(errorLog).toHaveBeenCalledExactlyOnceWith(failure.message)
      reportCliError(failure, true)
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(JSON.parse(logSpy.mock.calls[0][0]).error.message).toBe(failure.message)
      expect(failure.message).toContain(preferred)
      if (fallback === 'unsafe') {
        expect(failure.message).toContain(generic)
      }
      expect(failure.message).toContain('Windows could not start')
      expect(failure.message).toContain(WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL)
      expect(failure.message).toContain('full absolute path')
      expect(failure.message).toContain(
        String.raw`npm install --prefix C:\tools\orca-opencode2 @opencode/cli`
      )
      expect(failure.message).toContain('first match')
      expect(failure.message).toContain('move/rename only its suffixed opencode2 launchers')
      expect(failure.message).toContain('shared npm PATH directories unchanged')
      expect(failure.message).not.toContain(WINDOWS_BATCH_UNSAFE_ARGUMENTS_ERROR)
      expect(failure.message).not.toContain('Usage:')
      if (fallback === 'v1') {
        // External discovery now exposes the safe first suffix; the old generic v1 is unchanged.
        const safe = String.raw`C:\tools\orca-opencode2\node_modules\.bin\opencode2.cmd`
        resolved.set('opencode2', safe)
        expect(resolved.get('opencode')).toBe(generic)
        spawnProcessMock
          .mockClear()
          .mockImplementation(() =>
            helpChild('--standalone  Run with a private server instead of the background service')
          )
        logSpy.mockClear()
        errorLog.mockClear()
        await ACCOUNT_HANDLERS['account add'](context('opencode', true))
        expect(spawnProcessMock).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            args: ['/d', '/c', '@', safe, 'auth', 'login', '--help']
          })
        )
        expect(spawnMock).toHaveBeenCalledExactlyOnceWith(
          getCmdExePath(),
          ['/d', '/c', '@', safe, 'auth', 'login', '--standalone'],
          expect.anything()
        )
        const loginEnv = spawnMock.mock.calls[0][2].env
        expect(callMock).toHaveBeenLastCalledWith('accounts.addDataFromHome', {
          provider: 'opencode',
          sourceDataHome: loginEnv.XDG_DATA_HOME,
          label: 'opencode'
        })
        expect(existsSync(loginEnv.XDG_DATA_HOME)).toBe(false)
        expect(errorLog).not.toHaveBeenCalled()
        expect(warn).not.toHaveBeenCalled()
      }
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
      ['/d', '/c', '@', 'C:\\tools\\codex.cmd', 'login', '--device-auth'],
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
      ['/d', '/c', '@', shim, 'login', '--device-auth'],
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

  it('rejects `--agent` with no value instead of defaulting to Claude', async () => {
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
