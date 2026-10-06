import { describe, expect, it, vi } from 'vitest'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../provider-process/provider-process-supervisor'
import type { ClaudeChildTreeReaper } from './claude-agent-sdk-exit-proof'
import { proveClaudeChildExitWithReaper } from './claude-child-exit-proof-ladder'

function fakeTree(): ClaudeChildTreeReaper & { reap: ReturnType<typeof vi.fn> } {
  return {
    capture: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    reap: vi.fn(async () => 'exited' as const),
    treeVerdict: 'exited'
  }
}

/** A root that leaves only once a SIGTERM has had `stopMs` to act, the way a supervisor does. */
function rootStoppedBySigterm(stopMs: number) {
  let exited = false
  let settle = (): void => {}
  const exitPromise = new Promise<void>((resolve) => {
    settle = resolve
  })
  const kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (signal === 'SIGTERM') {
      setTimeout(() => {
        exited = true
        settle()
      }, stopMs)
    }
    return true
  })
  const stdin = { end: vi.fn() }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The ladder reads only pid, kill and stdin.end from its child.
    child: { pid: 4321, kill, stdin } as unknown as Parameters<
      typeof proveClaudeChildExitWithReaper
    >[0]['child'],
    kill,
    stdin,
    exitPromise,
    exited: () => exited
  }
}

describe('Claude child exit proof ladder', () => {
  it('stops a supervised child with SIGTERM and waits out the supervisor stop before forcing', async () => {
    // Slower than the unsupervised 1.5 s grace, still inside the supervisor's own bound.
    const root = rootStoppedBySigterm(PROVIDER_SUPERVISOR_MAX_STOP_MS - 500)
    const tree = fakeTree()

    await expect(
      proveClaudeChildExitWithReaper({ ...root, supervised: true, tree }, () => tree)
    ).resolves.toBe(true)

    expect(root.stdin.end).toHaveBeenCalled()
    expect(root.kill).toHaveBeenCalledWith('SIGTERM')
    // Forcing here would SIGKILL the supervisor mid-stop and orphan Claude in its own group.
    expect(root.kill).not.toHaveBeenCalledWith('SIGKILL')
    expect(tree.reap).not.toHaveBeenCalled()
  }, 10_000)

  it('never signals an unsupervised child for the graceful stop', async () => {
    const root = rootStoppedBySigterm(0)
    const tree = fakeTree()

    await proveClaudeChildExitWithReaper({ ...root, tree }, () => tree)

    // On Windows a direct SIGTERM is TerminateProcess: stdin end stays the only graceful rung.
    expect(root.stdin.end).toHaveBeenCalled()
    expect(root.kill).not.toHaveBeenCalledWith('SIGTERM')
    expect(tree.reap).toHaveBeenCalled()
  }, 10_000)
})
