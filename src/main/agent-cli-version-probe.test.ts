import { probeClaudeCliVersion } from './claude/claude-hook-event-versions'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkAgentCliVersion } from './agent-cli-version-probe'

const { runProcess } = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess }))

const INPUT = { program: '/opt/bin/agent', cwd: '/repo', env: { PATH: '/opt/bin' } }
const OPENCODE_MINIMUMS = ['1.18.31', '2.0.14']

function prints(stdout: string, result: Record<string, unknown> = {}): void {
  runProcess.mockResolvedValue({
    code: 0,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
    ...result
  })
}

describe('checkAgentCliVersion', () => {
  afterEach(() => vi.restoreAllMocks())
  beforeEach(() => runProcess.mockReset())

  it('asks the program for its version, bounded, where and as the launch would run it', async () => {
    prints('1.18.31\n')
    expect(await checkAgentCliVersion(INPUT, OPENCODE_MINIMUMS)).toEqual({
      status: 'ready',
      version: '1.18.31'
    })
    expect(runProcess).toHaveBeenCalledWith({
      ...INPUT,
      args: ['--version'],
      terminationBarrier: true,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
      killOnOutputLimit: true
    })
  })

  it.each([
    ['opencode v2.0.21\n', '2.0.21'],
    ['omp/17.0.5\n', '17.0.5']
  ])('reads a version printed with a name, prefix or slash: %j', async (stdout, version) => {
    prints(stdout)
    expect(await checkAgentCliVersion(INPUT, [])).toEqual({ status: 'ready', version })
  })

  it.each([
    ['1.18.31', null],
    ['1.18.30', '1.18.31'],
    ['2.0.13', '2.0.14'],
    ['2.0.14-rc.1', '2.0.14'],
    ['2.0.14', null],
    ['3.0.0', null],
    ['3.0.0-beta.1', null],
    ['0.9.0', '1.18.31']
  ])('holds OpenCode %s to its minimum (too old for %s)', async (version, minimumVersion) => {
    const check = await checkAgentCliVersion(INPUT, OPENCODE_MINIMUMS, async () => ({ version }))
    expect(check).toEqual(
      minimumVersion ? { status: 'tooOld', version, minimumVersion } : { status: 'ready', version }
    )
  })

  it('reads a version printed only on stderr, as Pi 0.73 does', async () => {
    prints('', { stderr: '0.73.1\n' })
    expect(await checkAgentCliVersion(INPUT, ['0.84.0'])).toEqual({
      status: 'tooOld',
      version: '0.73.1',
      minimumVersion: '0.84.0'
    })
  })

  it.each([
    ['a non-zero exit', { code: 1 }],
    ['a timeout', { timedOut: true }],
    ['oversized output', { outputTruncated: true }],
    ['no version in its output', { stdout: 'usage: agent [options]\n' }]
  ])('cannot tell after %s', async (_label, result) => {
    prints('1.18.31\n', result)
    expect(await checkAgentCliVersion(INPUT, OPENCODE_MINIMUMS)).toEqual({
      status: 'unknown',
      version: null
    })
  })

  it('calls a program that does not start missing', async () => {
    runProcess.mockImplementationOnce(() => {
      throw new Error('spawn ENOENT')
    })
    expect(await checkAgentCliVersion(INPUT, OPENCODE_MINIMUMS)).toEqual({
      status: 'missing',
      version: null
    })
  })

  it('says why it refused, with what the binary printed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    prints('', { code: 1, stderr: 'Error: EACCES mkdir /x\n' })
    await checkAgentCliVersion(INPUT, OPENCODE_MINIMUMS)
    prints('2.0.13\n')
    await checkAgentCliVersion(INPUT, OPENCODE_MINIMUMS)
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      '[agent-cli-version] /opt/bin/agent --version: exited 1: Error: EACCES mkdir /x',
      '[agent-cli-version] /opt/bin/agent --version: 2.0.13 is older than 2.0.14'
    ])
    warn.mockRestore()
  })
})

it('probes the agent behind a launcher with tree teardown', async () => {
  prints('0.84.0')
  await checkAgentCliVersion({ ...INPUT, prefixArgs: ['run', '--', 'pi'] }, ['0.84.0'])
  expect(runProcess).toHaveBeenLastCalledWith(
    expect.objectContaining({
      program: INPUT.program,
      args: ['run', '--', 'pi', '--version'],
      terminationBarrier: true
    })
  )
})

it('probes Claude through its prefix with the same tree teardown', async () => {
  prints('2.1.280 (Claude Code)')
  await expect(
    probeClaudeCliVersion(INPUT.program, {
      cwd: INPUT.cwd,
      env: INPUT.env,
      prefixArgs: ['run', '--', 'claude']
    })
  ).resolves.toBe('2.1.280')
  expect(runProcess).toHaveBeenLastCalledWith(
    expect.objectContaining({
      program: INPUT.program,
      args: ['run', '--', 'claude', '--version'],
      terminationBarrier: true
    })
  )
})
