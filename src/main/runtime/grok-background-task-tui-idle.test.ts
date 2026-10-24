import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/grok-bg',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/grok-bg',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

const LIVE_HUD = [
  '\x1b]0;grok\x07',
  'Tasks 1\n',
  'Task Background sleep 60 for Orca repro  33s\n',
  'watching · 1 command\n',
  '> '
].join('')

function runtimeWithPty(): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies the store subset used by terminal observations.
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  return runtime
}

describe('tui-idle while Grok background tasks run', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // Why (#9905): an idle OSC title plus a ready composer is not task-complete
  // while the Tasks HUD still lists work.
  it('does not resolve tui-idle while Grok background tasks are still active', async () => {
    vi.useFakeTimers()
    const runtime = runtimeWithPty()
    const { handle } = await runtime.createTerminal('path:/tmp/worktree-a')
    runtime.onPtyData('pty-bg', LIVE_HUD, Date.now())

    const waitPromise = runtime.waitForTerminal(handle, {
      condition: 'tui-idle',
      timeoutMs: 5_000
    })
    const timeoutAssertion = expect(waitPromise).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(5_000)
    await timeoutAssertion
  })

  it('resolves tui-idle for Grok once background tasks clear', async () => {
    vi.useFakeTimers()
    const runtime = runtimeWithPty()
    const { handle } = await runtime.createTerminal('path:/tmp/worktree-a')
    runtime.onPtyData('pty-bg', LIVE_HUD, Date.now())
    const waitPromise = runtime.waitForTerminal(handle, {
      condition: 'tui-idle',
      timeoutMs: 10_000
    })

    runtime.onPtyData(
      'pty-bg',
      ['\x1b]0;grok\x07', 'Tasks 0\n', 'No background tasks\n', '> '].join(''),
      Date.now()
    )

    const settled = expect(waitPromise).resolves.toMatchObject({
      handle,
      condition: 'tui-idle'
    })
    await vi.advanceTimersByTimeAsync(2_500)
    await settled
  })

  it('does not resolve tui-idle on an idle OSC title while Grok background tasks remain', async () => {
    vi.useFakeTimers()
    const runtime = runtimeWithPty()
    const { handle } = await runtime.createTerminal('path:/tmp/worktree-a')
    runtime.onPtyData(
      'pty-bg',
      [
        '\x1b]0;\u280b Grok\x07',
        'Tasks 1\n',
        'Task Background sleep 60 for Orca repro  33s\n',
        'watching · 1 command\n',
        '> '
      ].join(''),
      Date.now()
    )

    const waitPromise = runtime.waitForTerminal(handle, {
      condition: 'tui-idle',
      timeoutMs: 5_000
    })
    let settled: 'resolved' | 'rejected' | null = null
    void waitPromise.then(
      () => {
        settled = 'resolved'
      },
      () => {
        settled = 'rejected'
      }
    )

    runtime.onPtyData('pty-bg', '\x1b]0;Grok\x07', Date.now())
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled).toBeNull()

    const timeoutAssertion = expect(waitPromise).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(5_000)
    await timeoutAssertion
    expect(settled).toBe('rejected')
  })
})
