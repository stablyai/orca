import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock, runtimeMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  runtimeMock: vi.fn()
}))
vi.mock('./daemon-bun-runtime', () => ({ resolveDesktopDaemonBunRuntime: runtimeMock }))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))

import { probeFolderAccessForFreshDaemon } from './daemon-folder-access-probe'

type RunProcessSpec = {
  program: string
  args: string[]
  env: NodeJS.ProcessEnv
  timeoutMs: number
  maxOutputBytes: number
  onChildTerminated?: () => void
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
  runtimeMock.mockResolvedValue(null)
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

    expect(lastSpec().timeoutMs).toBeGreaterThan(0)
    expect(lastSpec().timeoutMs).toBeLessThanOrEqual(3_000)
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

it('uses the same Bun executable as a fresh desktop daemon', async () => {
  runtimeMock.mockResolvedValue({
    execPath: '/app/cli-runtime/bun-runtime',
    entryPath: '/app/terminal-daemon/daemon-entry.js'
  })
  settled('{"outcome":"ok"}\n')
  await expect(probeFolderAccessForFreshDaemon(DOCUMENTS)).resolves.toBe('ok')
  expect(lastSpec().program).toBe('/app/cli-runtime/bun-runtime')
  expect(lastSpec().env.ELECTRON_RUN_AS_NODE).toBeUndefined()
})

it('bounds runtime resolution and never launches a child after the deadline', async () => {
  vi.useFakeTimers()
  try {
    let finish!: (value: null) => void
    runtimeMock.mockReturnValue(
      new Promise<null>((resolve) => {
        finish = resolve
      })
    )
    const result = probeFolderAccessForFreshDaemon(DOCUMENTS)
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(result).resolves.toBe('unknown')
    finish(null)
    await vi.advanceTimersByTimeAsync(1)
    expect(runProcessMock).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('gives the child only the budget left after runtime resolution', async () => {
  vi.useFakeTimers()
  try {
    runtimeMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(null), 2_000))
    )
    settled('{"outcome":"ok"}\n')
    const result = probeFolderAccessForFreshDaemon(DOCUMENTS)
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(result).resolves.toBe('ok')
    expect(lastSpec().timeoutMs).toBe(1_000)
  } finally {
    vi.useRealTimers()
  }
})

it('releases a launch pin that resolves after the caller deadline', async () => {
  vi.useFakeTimers()
  try {
    const releaseLaunchPin = vi.fn()
    let finish:
      | ((value: { execPath: string; entryPath: string; releaseLaunchPin: () => void }) => void)
      | undefined
    runtimeMock.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const result = probeFolderAccessForFreshDaemon(DOCUMENTS)
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(result).resolves.toBe('unknown')
    finish?.({ execPath: 'bun', entryPath: 'daemon-entry.js', releaseLaunchPin })
    await vi.advanceTimersByTimeAsync(1)
    expect(releaseLaunchPin).toHaveBeenCalledTimes(1)
    expect(runProcessMock).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it.each([false, true])(
  'releases the launch pin when child termination is confirmed (failure=%s)',
  async (failure) => {
    const releaseLaunchPin = vi.fn()
    runtimeMock.mockResolvedValue({
      execPath: 'bun',
      entryPath: 'daemon-entry.js',
      releaseLaunchPin
    })
    runProcessMock.mockImplementation(async (spec: RunProcessSpec) => {
      expect(releaseLaunchPin).not.toHaveBeenCalled()
      spec.onChildTerminated?.()
      if (failure) {
        throw new Error('spawn failed')
      }
      return { code: 0, stdout: '{"outcome":"ok"}', timedOut: false }
    })
    await expect(probeFolderAccessForFreshDaemon(DOCUMENTS)).resolves.toBe(
      failure ? 'unknown' : 'ok'
    )
    expect(releaseLaunchPin).toHaveBeenCalledTimes(1)
  }
)

it.each(['resolve', 'reject'])(
  'retains the runtime after abort and process promise %s until confirmed termination',
  async (outcome) => {
    vi.useFakeTimers()
    try {
      const releaseLaunchPin = vi.fn()
      runtimeMock.mockResolvedValue({
        execPath: 'bun',
        entryPath: 'daemon-entry.js',
        releaseLaunchPin
      })
      let settle: (() => void) | undefined
      runProcessMock.mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            settle = () =>
              outcome === 'resolve'
                ? resolve({ code: null, stdout: '', timedOut: true })
                : reject(new Error('could not kill child'))
          })
      )
      const result = probeFolderAccessForFreshDaemon(DOCUMENTS)
      await vi.advanceTimersByTimeAsync(3_000)
      await expect(result).resolves.toBe('unknown')
      expect(releaseLaunchPin).not.toHaveBeenCalled()
      settle?.()
      await vi.advanceTimersByTimeAsync(1)
      expect(releaseLaunchPin).not.toHaveBeenCalled()
      lastSpec().onChildTerminated?.()
      expect(releaseLaunchPin).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  }
)
