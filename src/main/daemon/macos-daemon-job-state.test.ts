import { beforeEach, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../../shared/child-process/process-spec'

const { run } = vi.hoisted(() => ({ run: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>() }))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: run }))
import { readMacDaemonJobState, stopMacDaemonJob } from './macos-daemon-job-state'

const result: ProcessResult = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
beforeEach(() => run.mockReset())

it.each([
  ['\tstate = running\n\t\tstate = active', 'running'],
  ['\tstate = not running\n\t\tstate = active', 'stopped'],
  ['\t\tstate = active', 'unverifiable']
])('reads only the top-level job state from %s', async (stdout, expected) => {
  run.mockResolvedValue({ ...result, stdout })
  expect(await readMacDaemonJobState('gui/501/owned')).toBe(expected)
})

it.each([
  { code: 113, stderr: 'Could not find service "owned"', expected: 'missing' },
  { code: 113, stderr: 'Could not find service; Permission denied', expected: 'unverifiable' },
  { code: 1, stderr: 'Could not find service "owned"', expected: 'unverifiable' },
  { code: 0, stdout: '\tstate = running', timedOut: true, expected: 'unverifiable' },
  { code: 0, stdout: '\tstate = running', outputTruncated: true, expected: 'unverifiable' }
])('preserves uncertainty for $expected', async ({ expected, ...override }) => {
  run.mockResolvedValue({ ...result, ...override })
  expect(await readMacDaemonJobState('gui/501/owned')).toBe(expected)
})

it('accepts an already removed job but refuses an unverified bootout', async () => {
  run.mockResolvedValueOnce({ ...result, code: 3 }).mockResolvedValueOnce({
    ...result,
    code: 113,
    stderr: 'Could not find service "owned"'
  })
  await expect(stopMacDaemonJob('gui/501/owned')).resolves.toBeUndefined()
  run.mockResolvedValue({ ...result, code: 1 })
  await expect(stopMacDaemonJob('gui/501/owned')).rejects.toThrow('Could not stop')
})
