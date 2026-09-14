import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Repo } from '../shared/repo-types'

vi.mock('./effective-hook-config', () => ({
  getEffectiveHooksFromConfig: (_repo: unknown, hooks: unknown) => hooks
}))

const REPO: Repo = { id: 'r', path: '/repo', displayName: 'r', badgeColor: '#000', addedAt: 0 }

/**
 * Run a hook past its deadline with `process.kill` intercepted, so the escalation's decisions are
 * observed directly instead of raced against the kernel. `groupAlive` answers the signal-0 probe.
 */
async function signalsFromTimedOutHook(groupAlive: boolean): Promise<string[]> {
  const { runHook } = await import('./hooks')
  const dir = mkdtempSync(join(tmpdir(), 'orca-hook-signals-'))
  writeFileSync(join(dir, 'orca.yaml'), 'scripts:\n  archive: |\n    sleep 30\n')
  const sent: string[] = []
  const fakeKill = (pid: number, signal?: string | number): true => {
    if (signal === 0) {
      if (!groupAlive) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      }
      return true
    }
    sent.push(`${pid < 0 ? 'group' : 'child'}:${String(signal)}`)
    return true
  }
  const spy = vi.spyOn(process, 'kill').mockImplementation(fakeKill)
  try {
    await runHook('archive', dir, REPO, dir, undefined, 100)
    await new Promise((resolve) => setTimeout(resolve, 2_400))
    return sent
  } finally {
    spy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  }
}

// Why (#19334): the escalation exists for descendants that outlive the shell — a setup hook that
// backgrounds a server typically loses its leader to the first SIGTERM while the server keeps
// running. Keying the skip on the CHILD's exit would miss exactly that case; the probe asks the
// GROUP instead. The residual hazard, stated in hooks.ts: a recycled pid answers the probe too.
describe.skipIf(process.platform === 'win32')('archive hook termination', () => {
  it('escalates to the group when members survive the first signal', async () => {
    await expect(signalsFromTimedOutHook(true)).resolves.toEqual(['group:SIGTERM', 'group:SIGKILL'])
  }, 20_000)

  it('sends nothing once the group is provably empty', async () => {
    // A group that answers ESRCH has no members left to kill, and its pid may since belong to
    // someone else — so neither the SIGTERM nor the escalation is delivered.
    await expect(signalsFromTimedOutHook(false)).resolves.toEqual([])
  }, 20_000)
})

// The regression the group probe exists for, pinned directly because it cannot be reproduced
// through `runHook` with signals intercepted: with `process.kill` mocked nothing actually dies, so
// the child never reaches the exited state that a child-liveness skip would key on.
describe.skipIf(process.platform === 'win32')('terminateHookTree', () => {
  const fakeChild = (exited: boolean) => ({
    pid: 4242,
    exitCode: exited ? 0 : null,
    signalCode: null,
    kill: vi.fn()
  })

  it('signals a surviving group even though the shell leader already exited', async () => {
    const { terminateHookTree } = await import('./hooks')
    const sent: (string | number | undefined)[][] = []
    const recordKill = (pid: number, signal?: string | number): true => {
      if (signal !== 0) {
        sent.push([pid, signal])
      }
      return true
    }
    const spy = vi.spyOn(process, 'kill').mockImplementation(recordKill)
    try {
      // A hook that backgrounds a server loses its leader to the first SIGTERM; the server lives on.
      terminateHookTree(fakeChild(true), 'SIGKILL')
      expect(sent).toEqual([[-4242, 'SIGKILL']])
    } finally {
      spy.mockRestore()
    }
  })

  it('sends nothing when the group answers ESRCH', async () => {
    const { terminateHookTree } = await import('./hooks')
    const child = fakeChild(true)
    const emptyGroup = (): true => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    }
    const spy = vi.spyOn(process, 'kill').mockImplementation(emptyGroup)
    try {
      terminateHookTree(child, 'SIGKILL')
      expect(child.kill).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
