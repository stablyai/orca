import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inspectProcessChildren } from './pty-child-process-inspection'
import { runProcess } from '../shared/child-process/run-process'

vi.mock('../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))

const result = (overrides: Partial<Awaited<ReturnType<typeof runProcess>>> = {}) => ({
  code: 0,
  signal: null,
  stdout: '42\n',
  stderr: '',
  timedOut: false,
  ...overrides
})

describe('inspectProcessChildren', () => {
  beforeEach(() => vi.mocked(runProcess).mockReset())

  it('reports children only from successful pgrep output', async () => {
    vi.mocked(runProcess).mockResolvedValue(result())

    await expect(inspectProcessChildren(41)).resolves.toEqual({ hasChildProcesses: true })
    expect(runProcess).toHaveBeenCalledWith({
      program: 'pgrep',
      args: ['-P', '41'],
      timeoutMs: 3000
    })
  })

  it('reports no children only from the pgrep no-match exit', async () => {
    vi.mocked(runProcess).mockResolvedValue(result({ code: 1, stdout: '' }))

    await expect(inspectProcessChildren(41)).resolves.toEqual({ hasChildProcesses: false })
  })

  it.each([
    result({ code: 0, stdout: '' }),
    result({ code: 2, stdout: '' }),
    result({ code: null, signal: 'SIGTERM', stdout: '' }),
    result({ code: 1, stdout: '', timedOut: true })
  ])('marks degraded process reads unavailable', async (processResult) => {
    vi.mocked(runProcess).mockResolvedValue(processResult)

    await expect(inspectProcessChildren(41)).resolves.toEqual({
      hasChildProcesses: false,
      unavailable: true
    })
  })

  it('marks spawn failures unavailable', async () => {
    vi.mocked(runProcess).mockImplementationOnce(() => {
      throw new Error('pgrep missing')
    })

    await expect(inspectProcessChildren(41)).resolves.toEqual({
      hasChildProcesses: false,
      unavailable: true
    })
  })
})
