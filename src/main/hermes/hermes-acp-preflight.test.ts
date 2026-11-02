import { beforeEach, describe, expect, it, vi } from 'vitest'

const run = vi.hoisted(() => vi.fn())
vi.mock('@orca/process-host', () => ({ runProcess: run }))
import { assertAcpDependency, assertHermesAcpDependency } from './hermes-acp-preflight'

const invocation = {
  program: 'hermes',
  prefixArgs: [],
  cwd: '/workspace',
  env: { HERMES_HOME: '/home/hermes' }
}

describe('Hermes ACP dependency preflight', () => {
  beforeEach(() => run.mockReset())

  it('reports the missing ACP dependency before starting a chat', async () => {
    run.mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: "ModuleNotFoundError: No module named 'acp'",
      timedOut: false,
      outputTruncated: false
    })
    await expect(assertHermesAcpDependency(invocation)).rejects.toThrow(
      'Run `hermes acp --check` for the install command'
    )
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ program: 'hermes', args: ['acp', '--check'], env: invocation.env })
    )
  })

  it('permits unknown checks and unsupported older Hermes releases', async () => {
    run.mockResolvedValue({
      code: 2,
      stdout: '',
      stderr: 'unrecognized arguments: --check',
      timedOut: false,
      outputTruncated: false
    })
    await expect(assertHermesAcpDependency(invocation)).resolves.toBeUndefined()
  })

  it('does not probe unrelated agents', async () => {
    await assertAcpDependency('grok', invocation)
    expect(run).not.toHaveBeenCalled()
  })
})
