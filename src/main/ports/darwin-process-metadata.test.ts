import { ChildProcess } from 'node:child_process'
import type * as childProcessModule from 'node:child_process'
import { openSync } from 'node:fs'
import { devNull } from 'node:os'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runPortScanCommandInProcess } from './port-scan-command-execution'
import { scanWorkspacePorts } from './local-workspace-port-scanner'
import { killWorkspacePort } from './workspace-port-ownership'
import { resetWorkspacePortScanTimeoutBackoffForTests } from './local-workspace-port-scan-state'
import { LSOF_NONBLOCKING_ARGS } from '../../shared/process-observation/lsof-nonblocking-args'

const spawnMock = vi.hoisted(() => vi.fn())
const execFileMock = vi.hoisted(() => vi.fn())
const lockMock = vi.hoisted(() => vi.fn<() => number | null>())
vi.mock('@orca/process-host', () => ({ spawnProcess: spawnMock }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcessModule>()),
  execFile: execFileMock
}))
vi.mock('./darwin-port-scan-lock', () => ({ openDarwinPortScanLock: lockMock }))
vi.mock('./port-scan-command-client', () => ({
  runPortScanCommand: (...args: Parameters<typeof runPortScanCommandInProcess>) =>
    runPortScanCommandInProcess(...args),
  isPortScanWorkerUnavailableError: () => false
}))

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void

const cwdArgs = ['-O', ...LSOF_NONBLOCKING_ARGS, '-a', '-p', '123,456', '-d', 'cwd', '-Fn']
const worktrees = [{ id: 'repo::/repo', repoId: 'repo', displayName: 'main', path: '/repo' }]

function completedChild(
  stdout: string,
  code = 0,
  stderr = '',
  signal: NodeJS.Signals | null = null,
  chunkSize = 2_048
): ChildProcess {
  const out = new PassThrough()
  const err = new PassThrough()
  const child = Object.defineProperties(new ChildProcess(), {
    stdout: { value: out },
    stderr: { value: err }
  })
  vi.spyOn(child, 'kill').mockReturnValue(true)
  vi.spyOn(child, 'unref').mockImplementation(() => {})
  queueMicrotask(() => {
    for (let offset = 0; offset < stdout.length; offset += chunkSize) {
      out.write(stdout.slice(offset, offset + chunkSize))
    }
    err.write(stderr)
    child.emit('exit', code, signal)
    child.emit('close', code, signal)
    out.destroy()
    err.destroy()
  })
  return child
}

describe('Darwin selected-PID cwd completion', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    resetWorkspacePortScanTimeoutBackoffForTests()
    spawnMock.mockReset()
    execFileMock.mockReset()
    lockMock.mockReset().mockImplementation(() => openSync(devNull, 'r'))
  })
  afterEach(() => vi.restoreAllMocks())

  it('keeps a live workspace holder attributable and Stop-authorizable when an unrelated requested PID exits', async () => {
    let cwd = '/repo'
    spawnMock.mockImplementation(({ program, args }: { program: string; args: string[] }) => {
      if (program === '/usr/sbin/netstat') {
        return completedChild('')
      }
      if (program === '/bin/ps') {
        return completedChild(`123 node ${cwd}/server.js\n`)
      }
      if (args.includes('cwd')) {
        expect(args).toEqual(cwdArgs)
        return completedChild(`p123\nfcwd\nn${cwd}\n`, 1)
      }
      return completedChild(
        'p123\ncnode\nf18\nd0x1\nn127.0.0.1:5173\np456\ncnode\nf19\nd0x2\nn127.0.0.1:8080\n'
      )
    })
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const scan = await scanWorkspacePorts(worktrees, undefined, { requireMetadata: true })
    expect(scan.ports.find((port) => port.pid === 123)).toMatchObject({
      kind: 'workspace',
      owner: { worktreeId: 'repo::/repo', confidence: 'cwd' }
    })
    expect(scan.ports.find((port) => port.pid === 456)?.kind).toBe('external')
    expect(await killWorkspacePort(worktrees, { pid: 123, port: 5173 })).toEqual({ ok: true })
    expect(kill).toHaveBeenCalledExactlyOnceWith(123, 'SIGTERM')
    cwd = '/elsewhere'
    expect(await killWorkspacePort(worktrees, { pid: 123, port: 5173 })).toEqual({
      ok: false,
      reason: 'Only workspace-owned local processes can be stopped here.'
    })
    expect(kill).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls.map(([spec]) => spec.program)).toEqual(
      Array.from({ length: 3 }, () => ['/usr/sbin/lsof', '/usr/sbin/lsof', '/bin/ps']).flat()
    )
  })

  it('attributes a listener whose workspace path has non-ASCII characters', async () => {
    const cwdAsLsofPrintsItWithoutUtf8Locale = '/\\xec\\x9e\\x91\\xec\\x97\\x85/repo'
    spawnMock.mockImplementation(
      ({ program, args, env }: { program: string; args: string[]; env?: NodeJS.ProcessEnv }) => {
        if (program === '/usr/sbin/netstat') {
          return completedChild('')
        }
        if (program === '/bin/ps') {
          return completedChild('789 node server.js\n')
        }
        if (args.includes('cwd')) {
          const cwd = env?.LC_ALL?.endsWith('UTF-8')
            ? '/작업/repo'
            : cwdAsLsofPrintsItWithoutUtf8Locale
          return completedChild(`p789\nfcwd\nn${cwd}\n`)
        }
        return completedChild('p789\ncnode\nf20\nd0x3\nn127.0.0.1:4173\n')
      }
    )
    const scan = await scanWorkspacePorts(
      [{ id: 'repo::/작업/repo', repoId: 'repo', displayName: 'main', path: '/작업/repo' }],
      undefined,
      { requireMetadata: true }
    )
    expect(scan.ports.find((port) => port.pid === 789)).toMatchObject({
      kind: 'workspace',
      owner: { worktreeId: 'repo::/작업/repo', confidence: 'cwd' }
    })
  })

  it('runs the execFile fallback in a UTF-8 locale when the scan lock is unavailable', async () => {
    lockMock.mockReturnValue(null)
    execFileMock.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        queueMicrotask(() => callback(null, 'p789\nfcwd\nn/작업/repo\n', ''))
        return completedChild('')
      }
    )
    const cwdLsofArgs = ['-O', ...LSOF_NONBLOCKING_ARGS, '-a', '-p', '789', '-d', 'cwd', '-Fn']
    await expect(
      runPortScanCommandInProcess('/usr/sbin/lsof', cwdLsofArgs, 'attribution')
    ).resolves.toMatchObject({ stdout: 'p789\nfcwd\nn/작업/repo\n' })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(execFileMock).toHaveBeenCalledExactlyOnceWith(
      '/usr/sbin/lsof',
      cwdLsofArgs,
      expect.objectContaining({
        env: expect.objectContaining({ PATH: process.env.PATH, LC_ALL: 'en_US.UTF-8' })
      }),
      expect.any(Function)
    )
  })
})
