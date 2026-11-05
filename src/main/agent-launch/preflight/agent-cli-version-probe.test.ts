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
})
