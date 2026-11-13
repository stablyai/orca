import { ChildProcess } from 'node:child_process'
import { openSync } from 'node:fs'
import { devNull } from 'node:os'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runPortScanCommandInProcess } from './port-scan-command-execution'
import { scanWorkspacePorts } from './local-workspace-port-scanner'
import { killWorkspacePort } from './workspace-port-ownership'
import { resetWorkspacePortScanTimeoutBackoffForTests } from './local-workspace-port-scan-state'
import { LSOF_NONBLOCKING_ARGS } from '../../shared/lsof-nonblocking-args'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('@orca/process-host', () => ({ spawnProcess: spawnMock }))
vi.mock('./darwin-port-scan-lock', () => ({
  openDarwinPortScanLock: () => openSync(devNull, 'r')
}))
vi.mock('./port-scan-command-client', () => ({
  runPortScanCommand: (...args: Parameters<typeof runPortScanCommandInProcess>) =>
    runPortScanCommandInProcess(...args),
  isPortScanWorkerUnavailableError: () => false
}))

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
})
