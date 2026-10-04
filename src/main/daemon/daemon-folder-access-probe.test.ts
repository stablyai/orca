import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))

import { probeFolderAccessForFreshDaemon } from './daemon-folder-access-probe'

type RunProcessSpec = {
  program: string
  args: string[]
  env: NodeJS.ProcessEnv
  timeoutMs: number
  maxOutputBytes: number
}

function settled(stdout: string, overrides: Record<string, unknown> = {}): void {
  runProcessMock.mockResolvedValue({
    code: 0,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
    ...overrides
  })
}

function lastSpec(): RunProcessSpec {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the probe is the only caller of this mock and always passes a full ProcessSpec.
  return runProcessMock.mock.calls.at(-1)?.[0] as RunProcessSpec
}

const DOCUMENTS = '/Users/alice/Documents/repo'

beforeEach(() => {
  runProcessMock.mockReset()
})

describe('probeFolderAccessForFreshDaemon', () => {
  it('reports each outcome the child prints', async () => {
    for (const outcome of ['ok', 'denied', 'missing', 'other'] as const) {
      settled(`${JSON.stringify({ outcome })}\n`)
      await expect(probeFolderAccessForFreshDaemon(DOCUMENTS)).resolves.toBe(outcome)
    }
  })

  it('runs the app binary as plain Node with the path as its only argument', async () => {
    settled('{"outcome":"ok"}\n')
    await probeFolderAccessForFreshDaemon(DOCUMENTS)

    const spec = lastSpec()
    expect(spec.program).toBe(process.execPath)
    expect(spec.args[0]).toBe('-e')
    expect(spec.args.at(-1)).toBe(DOCUMENTS)
    expect(spec.args).toHaveLength(3)
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('scrubs the environment down to the child’s own needs', async () => {
    settled('{"outcome":"ok"}\n')
    vi.stubEnv('ORCA_SECRET_TOKEN', 'do-not-leak')
    await probeFolderAccessForFreshDaemon(DOCUMENTS)
    vi.unstubAllEnvs()

    const names = Object.keys(lastSpec().env).sort()
    expect(
      names.every((name) => ['ELECTRON_RUN_AS_NODE', 'PATH', 'HOME', 'TMPDIR'].includes(name))
    ).toBe(true)
    expect(names).not.toContain('ORCA_SECRET_TOKEN')
  })

  it('bounds the child by a deadline and an output cap', async () => {
    settled('{"outcome":"ok"}\n')
    await probeFolderAccessForFreshDaemon(DOCUMENTS)

    expect(lastSpec().timeoutMs).toBe(3_000)
    expect(lastSpec().maxOutputBytes).toBe(1024)
  })

  it('never passes the path through a shell', async () => {
    settled('{"outcome":"ok"}\n')
    await probeFolderAccessForFreshDaemon('/Users/alice/Documents/a b; rm -rf /')

    expect(lastSpec().args.at(-1)).toBe('/Users/alice/Documents/a b; rm -rf /')
  })

  // Why: the path is the child's sole argv entry, so Node reads a leading dash as its own option.
  it('refuses a relative path instead of handing it to Node as a flag', async () => {
    await expect(probeFolderAccessForFreshDaemon('-e')).resolves.toBe('unknown')
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('reads a timeout as unknown, never as a denial', async () => {
    settled('', { timedOut: true, code: null })
    await expect(probeFolderAccessForFreshDaemon(DOCUMENTS)).resolves.toBe('unknown')
  })

  it('reads a non-zero exit as unknown', async () => {
    settled('{"outcome":"denied"}\n', { code: 1 })
    await expect(probeFolderAccessForFreshDaemon(DOCUMENTS)).resolves.toBe('unknown')
  })

  it('reads truncated output as unknown', async () => {
    settled('{"outcome":"ok"}\n', { outputTruncated: true })
    await expect(probeFolderAccessForFreshDaemon(DOCUMENTS)).resolves.toBe('unknown')
  })

  it.each([
    ['empty output', ''],
    ['not JSON', 'denied\n'],
    ['JSON that is not an object', '"denied"\n'],
    ['an object without the field', '{"result":"denied"}\n'],
    ['a value outside the enum', '{"outcome":"maybe"}\n']
  ])('reads %s as unknown', async (_label, stdout) => {
    settled(stdout)
    await expect(probeFolderAccessForFreshDaemon(DOCUMENTS)).resolves.toBe('unknown')
  })

  it('reads a spawn failure as unknown', async () => {
    runProcessMock.mockRejectedValue(new Error('ENOENT'))
    await expect(probeFolderAccessForFreshDaemon(DOCUMENTS)).resolves.toBe('unknown')
  })
})
