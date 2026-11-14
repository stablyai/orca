import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkAgentCliVersion, readAgentCliVersion } from './agent-cli-version-probe'

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

  it('propagates owner cancellation instead of certifying a missing CLI', async () => {
    const owner = new AbortController()
    const closed = Promise.withResolvers<unknown>()
    runProcess.mockReturnValue(closed.promise)
    const read = checkAgentCliVersion({ ...INPUT, operation: { signal: owner.signal } }, [])
    const observed = expect(read).rejects.toThrow('superseded')
    owner.abort(new Error('superseded'))
    closed.resolve({ code: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: false })
    await observed
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

it('allows a catalog version prerequisite to complete late without changing normal preflight limits', async () => {
  const answer = Promise.withResolvers<unknown>()
  runProcess.mockReturnValueOnce(answer.promise)
  const catalog = readAgentCliVersion({ ...INPUT, timeoutMs: null })
  expect(runProcess.mock.lastCall?.[0].timeoutMs).toBeNull()
  answer.resolve({ code: 0, stdout: '1.18.31', stderr: '', timedOut: false })
  expect(await catalog).toEqual({ version: '1.18.31' })
  runProcess.mockResolvedValueOnce({ code: null, stdout: '', stderr: '', timedOut: true })
  expect(await readAgentCliVersion(INPUT)).toEqual({ version: null })
  expect(runProcess.mock.lastCall?.[0].timeoutMs).toBe(5_000)
})
