import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isStableCliVersionFrom,
  isStableCliVersionOnLine,
  probeAgentCliVersion
} from './agent-cli-version-probe'

const { runProcess } = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess }))

const INPUT = { program: '/opt/bin/agent', cwd: '/repo', env: { PATH: '/opt/bin' } }
const anyVersion = (): boolean => true

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

describe('probeAgentCliVersion', () => {
  beforeEach(() => runProcess.mockReset())

  it('asks the program for its version, bounded, where and as the launch would run it', async () => {
    prints('1.18.31\n')
    const seen: string[] = []
    expect(await probeAgentCliVersion(INPUT, (version) => (seen.push(version), true))).toBe(true)
    expect(seen).toEqual(['1.18.31'])
    expect(runProcess).toHaveBeenCalledWith({
      ...INPUT,
      args: ['--version'],
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
      killOnOutputLimit: true
    })
  })

  it('reads a version printed with a name or a v prefix', async () => {
    prints('opencode v2.0.21\n')
    const seen: string[] = []
    await probeAgentCliVersion(INPUT, (version) => (seen.push(version), true))
    expect(seen).toEqual(['2.0.21'])
  })

  it('reads a version printed after the program name and a slash', async () => {
    prints('omp/17.0.5\n')
    const seen: string[] = []
    await probeAgentCliVersion(INPUT, (version) => (seen.push(version), true))
    expect(seen).toEqual(['17.0.5'])
  })

  it.each([
    ['a non-zero exit', { code: 1 }],
    ['a timeout', { timedOut: true }],
    ['oversized output', { outputTruncated: true }]
  ])('cannot tell after %s', async (_label, result) => {
    prints('1.18.31\n', result)
    expect(await probeAgentCliVersion(INPUT, anyVersion)).toBe(false)
  })

  it('cannot tell when the output names no version, or the program does not start', async () => {
    prints('usage: agent [options]\n')
    expect(await probeAgentCliVersion(INPUT, anyVersion)).toBe(false)
    runProcess.mockImplementationOnce(() => {
      throw new Error('spawn ENOENT')
    })
    expect(await probeAgentCliVersion(INPUT, anyVersion)).toBe(false)
  })
})

describe('probeAgentCliVersion refusal', () => {
  beforeEach(() => runProcess.mockReset())

  it('says why it refused, with what the binary printed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    prints('', { code: 1, stderr: 'Error: EACCES mkdir /x\n' })
    await probeAgentCliVersion(INPUT, anyVersion)
    prints('2.0.21\n')
    await probeAgentCliVersion(INPUT, () => false)
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      '[agent-cli-version] /opt/bin/agent --version: exited 1: Error: EACCES mkdir /x',
      '[agent-cli-version] /opt/bin/agent --version: 2.0.21 is not a supported release'
    ])
    warn.mockRestore()
  })
})

describe('isStableCliVersionOnLine', () => {
  const line = { major: 1, floor: '1.18.31' }

  it.each([
    ['1.18.31', true],
    ['1.19.2', true],
    ['1.18.30', false],
    ['2.0.21', false],
    ['1.18.31-beta.1', false],
    ['11.0.0', false]
  ])('%s -> %s', (version, supported) => {
    expect(isStableCliVersionOnLine(version, line)).toBe(supported)
  })
})

describe('isStableCliVersionFrom', () => {
  it.each([
    ['17.0.5', true],
    ['17.2.12', true],
    ['18.4.5', true],
    ['17.0.4', false],
    ['16.9.0', false],
    ['18.0.0-beta.1', false]
  ])('%s -> %s', (version, supported) => {
    expect(isStableCliVersionFrom(version, '17.0.5')).toBe(supported)
  })
})
