import { ChildProcess } from 'node:child_process'
import { openSync } from 'node:fs'
import { devNull } from 'node:os'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runPortScanCommandInProcess } from './port-scan-command-execution'
import { scanWorkspacePorts } from './local-workspace-port-scanner'
import { killWorkspacePort } from './workspace-port-ownership'
import { resetWorkspacePortScanTimeoutBackoffForTests } from './local-workspace-port-scan-state'
import { scanPlatformListeningPorts } from './local-workspace-platform-port-scanner'
import * as outputFields from '../../shared/process-output-field-scanner'
import { DarwinNetstatListeners } from './darwin-netstat-listeners'
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
const survivingCwd = 'p123\nfcwd\nn/repo\n'
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

  it('still refuses failed or malformed cwd observations and nonzero results from other command roles', async () => {
    for (const [stdout, code, stderr, signal, args] of [
      [survivingCwd, 2, '', null, cwdArgs],
      [survivingCwd, 1, '', 'SIGTERM', cwdArgs],
      [survivingCwd.trimEnd(), 1, '', null, cwdArgs],
      ['p123\nfcwd\nn/repo\nmalformed\n', 1, '', null, cwdArgs],
      ['p999\nfcwd\nn/repo\n', 1, '', null, cwdArgs],
      [survivingCwd, 1, '', null, ['-O', '-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcnd']]
    ] as const) {
      spawnMock.mockImplementationOnce(() => completedChild(stdout, code, stderr, signal))
      await expect(
        runPortScanCommandInProcess('/usr/sbin/lsof', [...args], 'attribution')
      ).rejects.toThrow()
    }
  })

  it('ignores healthy lsof diagnostics but rejects diagnostic listener observations', async () => {
    for (const [stdout, code, args] of [
      ['p123\ncnode\nd0x1\nn127.0.0.1:5173\n', 0, ['-O', '-iTCP', '-sTCP:LISTEN', '-Fpcnd']],
      [survivingCwd, 1, cwdArgs]
    ] as const) {
      spawnMock.mockImplementationOnce(() => completedChild(stdout, code, 'lsof: diagnostic\n'))
      await expect(
        runPortScanCommandInProcess('/usr/sbin/lsof', [...args], 'attribution')
      ).resolves.toMatchObject({ stdout })
    }
    spawnMock.mockImplementationOnce(() => completedChild('', 0, 'netstat: diagnostic\n'))
    await expect(
      runPortScanCommandInProcess('/usr/sbin/netstat', ['-aln', '-p', 'tcp'], 'listeners')
    ).rejects.toThrow('Port scan observation is unavailable.')
  })

  it.each([100, 1_000])(
    'bounds ordinary acquisition and complete cwd validation for %i holders',
    async (count) => {
      const pids = Array.from({ length: count }, (_, index) => 1_000 + index)
      const pidList = pids.join(',')
      const header =
        'Active Internet connections (including servers)\nProto Recv-Q Send-Q Local Address Foreign Address (state)\n'
      const tcp =
        header +
        Array.from(
          { length: count * 10 },
          (_, index) =>
            `tcp4 0 0 127.0.0.1.${20_000 + Math.floor(index / 10)} *.* ${index % 10 ? 'ESTABLISHED' : 'LISTEN'}\n`
        ).join('')
      const cwd = pids
        .slice(0, -1)
        .map((pid) => `p${pid}\nfcwd\nn/repo\n`)
        .join('')
      let mode: 'missing' | 'known' | 'failed' | 'unrequested' = 'missing'
      let fieldChars = 0,
        fieldCalls = 0,
        streamChars = 0,
        validationChars = 0,
        memberships = 0,
        requested = 0,
        metadataChars = 0
      const fields = outputFields.getProcessOutputFields
      vi.spyOn(outputFields, 'getProcessOutputFields').mockImplementation((line, max) => {
        fieldChars += line.length
        fieldCalls += 1
        return fields(line, max)
      })
      const write = DarwinNetstatListeners.prototype.write
      vi.spyOn(DarwinNetstatListeners.prototype, 'write').mockImplementation(function (
        this: DarwinNetstatListeners,
        chunk
      ) {
        streamChars += chunk.length
        return write.call(this, chunk)
      })
      const test = RegExp.prototype.test,
        matchAll = String.prototype.matchAll
      const has = Set.prototype.has,
        split = String.prototype.split
      let validating = false
      // Count actual validation inputs and collection work; call every original implementation.
      vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (this: RegExp, text) {
        if (validating) {
          validationChars += text.length
        }
        return test.call(this, text)
      })
      vi.spyOn(String.prototype, 'matchAll').mockImplementation(function (this: string, pattern) {
        if (validating) {
          validationChars += this.length
        }
        return matchAll.call(this, pattern)
      })
      vi.spyOn(Set.prototype, 'has').mockImplementation(function (this: Set<unknown>, value) {
        if (validating) {
          memberships += 1
        }
        return has.call(this, value)
      })
      vi.spyOn(String.prototype, 'split').mockImplementation(function (
        this: string,
        separator,
        limit
      ) {
        const result = split.call(this, separator, limit)
        if (validating && String(this) === pidList) {
          requested += result.length
        }
        return result
      })
      const metadataChild = (text: string, code = 0): ChildProcess => {
        metadataChars += text.length
        return completedChild(text, code)
      }
      spawnMock.mockImplementation(({ program, args }: { program: string; args: string[] }) => {
        validating = false
        if (program === '/usr/sbin/netstat') {
          return completedChild(tcp)
        }
        if (program === '/bin/ps') {
          return metadataChild(pids.map((pid) => `${pid} node /repo/server.js\n`).join(''))
        }
        if (args.includes('cwd')) {
          expect(args[5]).toBe(pidList)
          const text =
            mode === 'known'
              ? `${cwd}p${pids.at(-1)}\nfcwd\nn/repo\n`
              : `${cwd}${mode === 'unrequested' ? 'p999999\nfcwd\nn/repo\n' : ''}`
          const child = metadataChild(text, mode === 'known' ? 0 : 1)
          child.prependOnceListener('close', () => {
            validating = true
            queueMicrotask(() => {
              validating = false
            })
          })
          return child
        }
        if (mode === 'failed') {
          return completedChild('', 2)
        }
        return completedChild(
          pids
            .map(
              (pid, index) =>
                `p${pid}\ncnode\nf18\n${mode === 'known' ? `d0x${pid}\n` : ''}n127.0.0.1:${30_000 + index}\n`
            )
            .join('')
        )
      })
      const run = async (commands: number) => {
        spawnMock.mockClear()
        fieldChars =
          fieldCalls =
          streamChars =
          validationChars =
          memberships =
          requested =
          metadataChars =
            0
        const result = await scanPlatformListeningPorts({})
        expect(spawnMock).toHaveBeenCalledTimes(commands)
        expect(
          spawnMock.mock.calls.filter(([spec]) => spec.program === '/usr/sbin/netstat')
        ).toHaveLength(1)
        expect(fieldCalls).toBeGreaterThanOrEqual(count * 10)
        expect(fieldCalls).toBeLessThanOrEqual(count * 14 + 10)
        expect(fieldChars).toBeGreaterThanOrEqual(tcp.length - count * 10 - 10)
        expect(fieldChars + streamChars).toBeLessThanOrEqual(4 * tcp.length)
        const bulk = spawnMock.mock.calls.filter(([spec]) => spec.args.includes('-p'))
        expect(bulk.length).toBeLessThanOrEqual(3)
        expect(
          bulk.reduce((sum, [spec]) => sum + spec.args.join(',').length, 0)
        ).toBeLessThanOrEqual(3 * pidList.length + 100)
        expect(metadataChars).toBeLessThanOrEqual(80 * count)
        if (commands === 2) {
          expect(metadataChars).toBe(0)
        } else {
          expect(metadataChars).toBeGreaterThanOrEqual(10 * (count - 1))
        }
        return result
      }
      for (let scan = 0; scan < 2; scan += 1) {
        const healthy = await run(4)
        expect(healthy.metadataAvailable).toBe(true)
        expect(healthy.ports).toHaveLength(count)
        expect(healthy.ports[0]).toMatchObject({ pid: pids[0], port: 30_000, cwd: '/repo' })
        expect(requested).toBe(count)
        expect(memberships).toBeGreaterThanOrEqual(count - 1)
        expect(memberships).toBeLessThanOrEqual(2 * count)
        expect(validationChars).toBeGreaterThanOrEqual(cwd.length + pidList.length)
        expect(validationChars).toBeLessThanOrEqual(4 * (cwd.length + pidList.length))
      }
      mode = 'known'
      await run(4)
      await run(2)
      mode = 'unrequested'
      const rejected = await run(3)
      expect(rejected.metadataAvailable).toBe(false)
      expect(memberships).toBe(count)
      expect(validationChars).toBeLessThanOrEqual(4 * (cwd.length + pidList.length + 100))
      mode = 'failed'
      const fallback = await run(2)
      expect(fallback.metadataAvailable).toBe(false)
      expect(fallback.ports).toHaveLength(count)
      expect(fallback.ports.every((port) => port.pid === undefined)).toBe(true)
      expect(fallback.ports[0]).toMatchObject({ port: 20_000 })
    }
  )
})
