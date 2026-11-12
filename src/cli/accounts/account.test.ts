import type * as NodeCliCommandResolutionModule from '../../shared/node-cli-command-resolution'
import type * as ProcessHostModule from '@orca/process-host'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  deleteKeychainMock,
  getVersionManagerBinPathsMock,
  readKeychainMock,
  resolveCliCommandMock,
  probeMock,
  spawnMock,
  stdioForWindowsInteractiveChildMock,
  writeKeychainMock
} = vi.hoisted(() => ({
  deleteKeychainMock: vi.fn(),
  getVersionManagerBinPathsMock: vi.fn(),
  readKeychainMock: vi.fn(),
  resolveCliCommandMock: vi.fn(),
  probeMock: vi.fn(),
  spawnMock: vi.fn(),
  stdioForWindowsInteractiveChildMock: vi.fn(),
  writeKeychainMock: vi.fn()
}))

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
vi.mock('../../main/claude-accounts/runtime-auth/keychain', () => ({
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
import type { RuntimeClient } from '../runtime/client'
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
})
