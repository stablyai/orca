import { beforeEach, describe, expect, it, vi } from 'vitest'
import { judgeTerminalForeground, readTerminalProcessRows } from './terminal-foreground-group'
import { readPtyTerminalRows } from '../pty/process-retirement/terminal-process-rows'
import { resolvePtyForegroundMembers } from '../pty/process-retirement/pty-master-foreground-observation'
import { readLaunchedAgentForeground } from './terminal/wait/launched-agent-foreground'
import { createAdapter } from '../daemon/providers/routing/testing/daemon-pty-router-test-fixture'
import { DaemonPtyRouter } from '../daemon/providers/routing/daemon-pty-router'

const mocks = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess: mocks.runProcess }))
vi.mock('../../shared/libproc-process-table', () => ({ runPsInProcess: async () => null }))

const rows = (pid: number) =>
  `${pid} 1 ${pid} ${pid + 1} Ss -zsh\n${pid + 1} ${pid} ${pid + 1} ${pid + 1} S+ claude\n`
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
    mocks.runProcess
      .mockResolvedValueOnce(result('ttys904'))
      .mockResolvedValueOnce(result(`${rows(90400)}90410 90400 90410 90401 S   \n`))
      .mockResolvedValueOnce(result('ttys904'))
    const captured = (await readTerminalProcessRows(90400)) ?? []
    expect(resolvePtyForegroundMembers(captured, 90401).verdict).toBe('observed')
    // Inside the foreground group the same blank argv proves nothing.
    const blank = captured.map((row) => (row.pid === 90401 ? { ...row, command: '' } : row))
    expect(judgeTerminalForeground(blank, 90400, 'claude')).toBe('unknown')
    expect(resolvePtyForegroundMembers(blank, 90401).verdict).toBe('unverifiable')
  })

  it('filters out processes from a different session ID sharing the same pts (docker pts clash)', async () => {
    // 90500 is root shell (sid 90500, tpgid 90501).
    // 90501 is claude agent in foreground (sid 90500, tpgid 90501).
    // 99000 is an independent docker container process on the same pts (sid 99000, tpgid 99000).
    const psOutput = [
      '90500 1 90500 90501 90500 Ss -zsh',
      '90501 90500 90501 90501 90500 S+ claude',
      '99000 1 99000 99000 99000 S+ python'
    ].join('\n')
    mocks.runProcess
      .mockResolvedValueOnce(result('pts/0'))
      .mockResolvedValueOnce(result(psOutput))
      .mockResolvedValueOnce(result('pts/0'))
    const captured = (await readTerminalProcessRows(90500)) ?? []
    expect(captured).toHaveLength(2)
    expect(captured.map((c) => c.pid)).toEqual([90500, 90501])
    expect(judgeTerminalForeground(captured, 90500, 'claude')).toBe('agent')
  })

  it.each([
    {
      platform: 'darwin',
      expectedFormat: 'pid=,ppid=,pgid=,tpgid=,stat=,command=',
      sampleOutput: '100 1 100 100 Ss -zsh\n'
    },
    {
      platform: 'linux',
      expectedFormat: 'pid=,ppid=,pgid=,tpgid=,sid=,stat=,command=',
      sampleOutput: '100 1 100 100 100 Ss -zsh\n'
    }
  ])(
    'queries terminal processes with platform-appropriate ps format on $platform',
    async ({ platform, expectedFormat, sampleOutput }) => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
      try {
        Object.defineProperty(process, 'platform', { value: platform })
        mocks.runProcess.mockResolvedValueOnce(result(sampleOutput))
        const captured = await readPtyTerminalRows('ttys001')
        expect(mocks.runProcess).toHaveBeenCalledWith(
          expect.objectContaining({
            program: 'ps',
            args: ['-ww', '-o', expectedFormat, '-t', 'ttys001']
          })
        )
        expect(captured).toHaveLength(1)
        expect(captured![0].pid).toBe(100)
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  )
})
