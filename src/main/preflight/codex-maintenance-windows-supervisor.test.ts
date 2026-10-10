import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { codexMaintenanceWindowsSpawnSpec } from './codex-maintenance-windows-supervisor'
const { resolve } = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('@orca/process-host/spawn-resolution', () => ({ resolveSpawn: resolve }))
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})
describe('Windows maintenance tree ownership', () => {
  it.each([
    {
      file: 'C:\\node\\node.exe',
      args: ['C:\\npm\\codex.js', 'update'],
      windowsVerbatimArguments: false
    },
    {
      file: 'C:\\Windows\\cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', 'encoded command'],
      windowsVerbatimArguments: true
    }
  ])('retains an IPC root above the shared resolved command: $file', (resolved) => {
    resolve.mockReturnValue({
      ...resolved,
      options: {
        windowsVerbatimArguments: resolved.windowsVerbatimArguments,
        env: { PATH: 'C:\\npm', NODE_OPTIONS: '--require fake' }
      }
    })
    const input = {
      program: 'C:\\npm\\codex.cmd',
      args: ['update'],
      cwd: 'C:\\workspace',
      env: { PATH: 'C:\\npm' }
    }
    const spec = codexMaintenanceWindowsSpawnSpec(input)
    expect(resolve).toHaveBeenCalledWith(input, 'win32')
    expect(spec.program).toBe(process.execPath)
    expect(spec.stdio).toEqual(['pipe', 'pipe', 'pipe', 'ipc'])
    expect(spec.serialization).toBe('json')
    const encoded = spec.env?.ORCA_MAINTENANCE_SUPERVISOR_SPEC
    if (!encoded) {
      throw new Error('No supervisor input')
    }
    const selected = JSON.parse(Buffer.from(encoded, 'base64').toString())
    expect(selected.file).toBe(resolved.file)
    expect(selected.args).toEqual(resolved.args)
    expect(selected.cwd).toBe(input.cwd)
    expect(selected.windowsVerbatimArguments).toBe(resolved.windowsVerbatimArguments)
    expect(selected.nodeOptions).toBe('--require fake')
    expect(spec.env?.NODE_OPTIONS).toBeUndefined()
    expect(spec.env?.ELECTRON_RUN_AS_NODE).toBe('1')
  })
  it('pins the host directory for a directory-sensitive updater when cwd is omitted', () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    const hostCwd = 'C:\\host-project'
    vi.spyOn(process, 'cwd').mockReturnValue(hostCwd)
    resolve.mockReturnValue({
      file: 'C:\\tools\\project-aware-codex.cmd',
      args: ['update'],
      options: { env: { PATH: 'C:\\tools' } }
    })
    const input = { program: 'C:\\tools\\project-aware-codex.cmd', args: ['update'] }
    const spec = codexMaintenanceWindowsSpawnSpec(input)
    expect(resolve).toHaveBeenCalledWith({ ...input, cwd: hostCwd }, 'win32')
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough()
    })
    const selections: string[] = []
    const spawn = vi.fn((_file: string, _args: string[], options: { cwd: string }) => {
      selections.push(options.cwd === hostCwd ? 'host installation' : 'other installation')
      return child
    })
    const owner = Object.assign(new EventEmitter(), {
      pid: 4242,
      env: spec.env,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough()
    })
    const script = spec.args?.[1]
    if (!script) {
      throw new Error('No supervisor script')
    }
    runInNewContext(script, { require: () => ({ spawn }), process: owner, Buffer })
    expect(selections).toEqual(['host installation'])
    expect(spec.cwd).toBe('C:\\Windows\\System32')
    owner.emit('disconnect')
    expect(spawn).toHaveBeenLastCalledWith(
      'C:\\Windows\\System32\\taskkill.exe',
      ['/pid', '4242', '/t', '/f'],
      { cwd: 'C:\\Windows\\System32', windowsHide: true, stdio: 'ignore' }
    )
  })
  it('uses the host system helper and safe cwd despite a project helper and redirected agent environment', () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    resolve.mockReturnValue({
      file: 'C:\\tools\\codex.exe',
      args: ['update'],
      options: { env: { PATH: 'C:\\project', SystemRoot: 'C:\\project' } }
    })
    const spec = codexMaintenanceWindowsSpawnSpec({
      program: 'C:\\tools\\codex.exe',
      cwd: 'C:\\project',
      env: { PATH: 'C:\\project', SystemRoot: 'C:\\project' }
    })
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough()
    })
    const projectHelper = vi.fn()
    const spawn = vi.fn((file: string) => {
      if (file === 'taskkill.exe' || file === 'C:\\project\\taskkill.exe') {
        projectHelper()
      }
      return child
    })
    const owner = Object.assign(new EventEmitter(), {
      pid: 4242,
      env: spec.env,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough()
    })
    const script = spec.args?.[1]
    if (!script) {
      throw new Error('No supervisor script')
    }
    runInNewContext(script, { require: () => ({ spawn }), process: owner, Buffer })
    owner.emit('disconnect')
    expect(projectHelper).not.toHaveBeenCalled()
    expect(spec.cwd).toBe('C:\\Windows\\System32')
    expect(spawn).toHaveBeenLastCalledWith(
      'C:\\Windows\\System32\\taskkill.exe',
      ['/pid', '4242', '/t', '/f'],
      { cwd: 'C:\\Windows\\System32', windowsHide: true, stdio: 'ignore' }
    )
    expect(spawn.mock.calls[0]).toEqual([
      'C:\\tools\\codex.exe',
      ['update'],
      expect.objectContaining({ cwd: 'C:\\project' })
    ])
  })
})
