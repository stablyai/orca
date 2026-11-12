import { expect, it, vi, beforeEach } from 'vitest'
import { runProcess } from '@orca/process-host'
import { assertCodexExecutionSource } from './codex-execution-source'
vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))
beforeEach(() => vi.clearAllMocks())
it.each(['clean', 'changed-head', 'dirty', 'failed', 'truncated'] as const)(
  'admits only the exact clean source: %s',
  async (state) => {
    const result = {
      code: 0,
      timedOut: false,
      outputTruncated: false,
      stdout: 'a'.repeat(40),
      stderr: '',
      signal: null
    }
    vi.mocked(runProcess)
      .mockResolvedValueOnce({
        ...result,
        stdout: state === 'changed-head' ? 'b'.repeat(40) : result.stdout
      })
      .mockResolvedValueOnce({
        ...result,
        stdout: state === 'dirty' ? ' M owned.py' : '',
        code: state === 'failed' ? 1 : 0,
        outputTruncated: state === 'truncated'
      })
    await (state === 'clean'
      ? expect(assertCodexExecutionSource('/admitted', 'a'.repeat(40))).resolves.toBeUndefined()
      : expect(assertCodexExecutionSource('/admitted', 'a'.repeat(40))).rejects.toThrow(
          'admitted clean revision'
        ))
    expect(vi.mocked(runProcess).mock.calls.every(([input]) => input.cwd === '/admitted')).toBe(
      true
    )
  }
)
