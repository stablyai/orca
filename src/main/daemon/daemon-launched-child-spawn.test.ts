import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnDaemonChildProcess } from './daemon-launched-child-spawn'

const { spawn, fork } = vi.hoisted(() => ({ spawn: vi.fn(), fork: vi.fn() }))
vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess: spawn }))
vi.mock('../../shared/child-process/fork-process', () => ({ forkProcess: fork }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getVersion: () => '1.0.0' })
}))
vi.mock('./daemon-launch-paths', () => ({ daemonLogArgs: () => [] }))

const options = {
  entryPath: '/app/daemon-entry.js',
  forkEntryPath: '/app/daemon-entry.js',
  userDataPath: '/tmp/orca',
  socketPath: '/tmp/orca/daemon.sock',
  tokenPath: '/tmp/orca/token',
  pidPath: '/tmp/orca/pid',
  launchNonce: 'scope-owner',
  macosLoginSessionWatch: false
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('daemon launch scope ownership', () => {
  it('only arms lifetime cleanup through the private scope launcher', () => {
    spawnDaemonChildProcess(options, true)
    expect(fork).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'systemd-run',
        args: expect.arrayContaining([
          '--scope',
          '--unit=orca-daemon-scope-owner.scope',
          '--property=TimeoutStopSec=5s',
          '--fresh-daemon-scope'
        ])
      })
    )
  })

  it('does not arm cleanup on the direct launch fallback', () => {
    spawnDaemonChildProcess(options, false)
    expect(spawn).not.toHaveBeenCalled()
    expect(fork).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.not.arrayContaining(['--fresh-daemon-scope'])
      })
    )
  })
})

it('launches the Bun payload directly without inherited Electron preload options', () => {
  vi.stubEnv('NODE_OPTIONS', '--require=/user/preload.js')
  vi.stubEnv('BUN_OPTIONS', '--preload=/user/preload.js')
  try {
    spawnDaemonChildProcess(
      {
        ...options,
        bunRuntime: true,
        relocatedExecPath: '/runtime/bun',
        conptyLibraryPath: 'C:\\runtime\\conpty\\conpty.dll'
      },
      false
    )
    expect(fork).not.toHaveBeenCalled()
    const call = spawn.mock.calls[0][0]
    expect(call.program).toBe('/runtime/bun')
    expect(call.args.slice(0, 4)).toEqual([
      '--no-env-file',
      process.platform === 'win32' ? '--config=NUL' : '--config=/dev/null',
      '--no-install',
      options.forkEntryPath
    ])
    expect(call.stdio).toContain('ipc')
    expect(call.env.NODE_OPTIONS).toBeUndefined()
    expect(call.env.NODE_PATH).toBeUndefined()
    expect(call.env.BUN_OPTIONS).toBeUndefined()
    expect(call.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(call.args).toContain('--spawner-exec-path')
  } finally {
    vi.unstubAllEnvs()
  }
})

it('selects only the verified Windows provider instead of an inherited override', () => {
  vi.stubGlobal('process', {
    ...process,
    platform: 'win32',
    env: { ...process.env, BUN_CONPTY_LIBRARY: 'C:\\foreign\\conpty.dll' }
  })
  const library = 'C:\\Orca Runtime\\conpty\\conpty.dll'
  spawnDaemonChildProcess(
    {
      ...options,
      bunRuntime: true,
      relocatedExecPath: 'C:\\Orca Runtime\\bun-runtime.exe',
      conptyLibraryPath: library
    },
    false
  )
  expect(spawn.mock.calls[0][0].env.BUN_CONPTY_LIBRARY).toBe(library)
})

it.each([undefined, 'conpty.dll'])(
  'refuses a Windows Bun launch without an absolute provider: %s',
  (conptyLibraryPath) => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    expect(() =>
      spawnDaemonChildProcess(
        {
          ...options,
          bunRuntime: true,
          relocatedExecPath: 'C:\\runtime\\bun-runtime.exe',
          conptyLibraryPath
        },
        false
      )
    ).toThrow('ConPTY library path must be absolute')
    expect(spawn).not.toHaveBeenCalled()
  }
)

it('does not pass an inherited ConPTY selector to a POSIX Bun daemon', () => {
  vi.stubGlobal('process', {
    ...process,
    platform: 'linux',
    env: { ...process.env, BUN_CONPTY_LIBRARY: '/foreign/conpty.dll' }
  })
  spawnDaemonChildProcess(
    { ...options, bunRuntime: true, relocatedExecPath: '/runtime/bun' },
    false
  )
  expect(spawn.mock.calls[0][0].env.BUN_CONPTY_LIBRARY).toBeUndefined()
})

it('places the Bun dotenv guard before the entry in a durable scope', () => {
  spawnDaemonChildProcess(
    {
      ...options,
      bunRuntime: true,
      relocatedExecPath: '/runtime/bun',
      conptyLibraryPath: 'C:\\runtime\\conpty\\conpty.dll'
    },
    true
  )
  const args: string[] = spawn.mock.calls[0][0].args
  const runtimeIndex = args.indexOf('/runtime/bun')
  expect(runtimeIndex).toBeGreaterThan(-1)
  expect(args.slice(runtimeIndex + 1, runtimeIndex + 5)).toEqual([
    '--no-env-file',
    process.platform === 'win32' ? '--config=NUL' : '--config=/dev/null',
    '--no-install',
    options.forkEntryPath
  ])
})

it.each([false, true])(
  'isolates the current headless Bun runtime with durable scope=%s',
  (scoped) => {
    vi.stubGlobal('process', {
      ...process,
      platform: 'linux',
      versions: { ...process.versions, electron: undefined, bun: '1.4.2' },
      env: {
        ...process.env,
        BUN_OPTIONS: '--preload=/foreign/preload.js',
        NODE_OPTIONS: '--require=/foreign/preload.js',
        NODE_PATH: '/foreign/modules'
      }
    })
    spawnDaemonChildProcess(options, scoped)
    const call = scoped ? spawn.mock.calls[0][0] : fork.mock.calls[0][0]
    expect(call.env.BUN_OPTIONS).toBeUndefined()
    expect(call.env.NODE_OPTIONS).toBeUndefined()
    expect(call.env.NODE_PATH).toBeUndefined()
    expect(call.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    if (scoped) {
      const index = call.args.indexOf(process.execPath)
      expect(index).toBeGreaterThan(-1)
      expect(call.args.slice(index + 1, index + 5)).toEqual([
        '--no-env-file',
        '--config=/dev/null',
        '--no-install',
        options.forkEntryPath
      ])
    }
  }
)

it('keeps verified ConPTY selection when headless Bun forks itself on Windows', () => {
  vi.stubGlobal('process', {
    ...process,
    platform: 'win32',
    versions: { ...process.versions, electron: undefined, bun: '1.4.2' },
    env: { ...process.env, BUN_CONPTY_LIBRARY: 'C:\\verified\\conpty.dll' }
  })
  spawnDaemonChildProcess(options, false)
  expect(fork.mock.calls[0][0].env.BUN_CONPTY_LIBRARY).toBe('C:\\verified\\conpty.dll')
})

it('does not add Bun flags when a Bun parent explicitly selects another runtime', () => {
  vi.stubGlobal('process', { ...process, versions: { ...process.versions, bun: '1.4.2' } })
  spawnDaemonChildProcess({ ...options, relocatedExecPath: '/other/node' }, true)
  expect(spawn.mock.calls[0][0].args).not.toContain('--no-env-file')
  expect(spawn.mock.calls[0][0].env.ELECTRON_RUN_AS_NODE).toBe('1')
})

it.each([false, true])('requires the selected desktop Bun runtime with scope=%s', (scoped) => {
  expect(() => spawnDaemonChildProcess({ ...options, bunRuntime: true }, scoped)).toThrow()
  expect(spawn).not.toHaveBeenCalled()
  expect(fork).not.toHaveBeenCalled()
})
