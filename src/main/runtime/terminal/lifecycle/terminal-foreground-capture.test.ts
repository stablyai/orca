import { beforeEach, describe, expect, it, vi } from 'vitest'
import { judgeTerminalForeground } from './terminal-foreground-group'
import {
  observePtyForeground,
  resolvePtyForegroundMembers
} from '../../../pty/process-retirement/pty-master-foreground-observation'
import { readTerminalProcessRows } from '../../../pty/process-retirement/terminal-process-rows'
import { readLaunchedAgentForeground } from '../wait/launched-agent-foreground'
import { createAdapter } from '../../../daemon/providers/routing/testing/daemon-pty-router-test-fixture'
import { DaemonPtyRouter } from '../../../daemon/providers/routing/daemon-pty-router'

const mocks = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess: mocks.runProcess }))
vi.mock('../../../../shared/libproc-process-table', () => ({ runPsInProcess: async () => null }))

// Linux ps prefixes the sid column readPtyTerminalRows asks for there.
const rows = (pid: number, withSid = process.platform === 'linux') =>
  `${pid} 1 ${pid} ${pid + 1} Ss -zsh\n${pid + 1} ${pid} ${pid + 1} ${pid + 1} S+ claude\n`
    .split('\n')
    .map((line) => (withSid && line ? `${pid} ${line}` : line))
    .join('\n')
const result = (stdout: string, outputTruncated = false) => ({
  code: 0,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false,
  outputTruncated
})

describe('fresh target foreground regressions', () => {
  beforeEach(() => {
    mocks.runProcess.mockReset()
  })

  it('observes the known target while an unrelated retained daemon inventory is unavailable', async () => {
    const current = createAdapter('current', ['target'])
    const legacy = createAdapter('legacy', ['unrelated'])
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.listProcesses()
    vi.mocked(current.listProcesses).mockResolvedValue([
      { id: 'target', rootProcessId: 500, cwd: '', title: '' }
    ])
    mocks.runProcess
      .mockResolvedValueOnce(result('ttys005'))
      .mockResolvedValueOnce(result(rows(500)))
      .mockResolvedValueOnce(result('ttys005'))
    vi.mocked(current.confirmForegroundProcess).mockResolvedValue('claude')
    vi.mocked(legacy.listProcesses).mockRejectedValue(new Error('unreachable old daemon'))
    await expect(router.confirmForegroundProcess('target')).resolves.toBe('claude')
    await expect(
      readLaunchedAgentForeground(
        {
          getForegroundProcess: (id) => router.getForegroundProcess(id),
          confirmForegroundProcess: (id) => router.confirmForegroundProcess(id),
          listProcesses: (_host, opts) => router.listProcesses(opts)
        },
        { remote: false, windows: false },
        'target',
        'claude'
      )
    ).resolves.toBe('agent')
    expect(legacy.listProcesses).toHaveBeenCalledTimes(1)
  })

  it('recovers a reused root PID on a different terminal in the same foreground read', async () => {
    let currentTty = 'ttys901'
    mocks.runProcess.mockImplementation(async ({ args }: { args: readonly string[] }) => {
      if (args.includes('-p')) {
        return result(`${currentTty}\n`)
      }
      return result(rows(args.includes(currentTty) ? 90100 : 90200))
    })
    await expect(readTerminalProcessRows(90100)).resolves.not.toBeNull()
    currentTty = 'ttys902'
    await expect(readTerminalProcessRows(90100)).resolves.not.toBeNull()
  })

  it('does not publish a truncated terminal capture as foreground proof', async () => {
    mocks.runProcess
      .mockResolvedValueOnce(result('ttys903\n'))
      .mockResolvedValueOnce(result(rows(90300), true))
    await expect(readTerminalProcessRows(90300)).resolves.toBeNull()
  })
  it.each([
    { timedOut: true },
    { signal: 'SIGTERM' },
    { stdout: `${rows(90300)}partial broken row` },
    { stdout: '' }
  ])('rejects incomplete terminal captures: %j', async (failure) => {
    mocks.runProcess
      .mockResolvedValueOnce(result('ttys903'))
      .mockResolvedValueOnce({ ...result(rows(90300)), ...failure })
    expect(await readTerminalProcessRows(90300)).toBeNull()
  })
  it('keeps a capture whose blank-argv row sits outside the foreground group', async () => {
    const blankOutside = `${process.platform === 'linux' ? '90400 ' : ''}90410 90400 90410 90401 S`
    mocks.runProcess
      .mockResolvedValueOnce(result('ttys904'))
      .mockResolvedValueOnce(result(`${rows(90400)}${blankOutside}\n`))
      .mockResolvedValueOnce(result('ttys904'))
    const captured = (await readTerminalProcessRows(90400)) ?? []
    expect(resolvePtyForegroundMembers(captured, 90401).verdict).toBe('observed')
    // Inside the foreground group the same blank argv proves nothing.
    const blank = captured.map((row) => (row.pid === 90401 ? { ...row, command: '' } : row))
    expect(judgeTerminalForeground(blank, 90400, 'claude')).toBe('unknown')
    expect(resolvePtyForegroundMembers(blank, 90401).verdict).toBe('unverifiable')
  })
})

// #39488: a `docker run -t` container holds its own private pts/0, so host `ps -t pts/0` lists its sleep beside
// the terminal's shell and agent. Rows are the reporter's capture; columns follow what ps was asked for.
const CONTAINER_SHARING_PTS = [
  { sid: 58769, row: '58769 58768 58769 58769 Ss+ sleep 900' },
  { sid: 58824, row: '58824 100 58824 58826 Ss+ /bin/sh -l' },
  { sid: 58824, row: '58826 58824 58826 58826 S+ claude --print-output' }
]

describe('terminal foreground with a container holding the same pts number', () => {
  it('observes the agent as foreground on Linux', async () => {
    mocks.runProcess.mockReset()
    const original = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    try {
      mocks.runProcess.mockImplementation(async ({ args }: { args: readonly string[] }) => {
        const withSid = args.some((arg) => arg.startsWith('sid='))
        return result(
          `${CONTAINER_SHARING_PTS.map(({ sid, row }) => (withSid ? `${sid} ${row}` : row)).join('\n')}\n`
        )
      })
      const owner = {
        pid: 58824,
        fd: 9,
        ptsName: '/dev/pts/0',
        getForegroundProcessGroup: (): number | null | undefined => 58826
      }
      await expect(observePtyForeground(owner, () => true)).resolves.toMatchObject({
        verdict: 'observed',
        foregroundKind: 'non-shell',
        foregroundPgid: 58826
      })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: original })
    }
  })
})
