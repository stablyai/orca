import { describe, expect, it } from 'vitest'
import { readMachineWorkAtRisk } from './machine-work-at-risk'

const meta = { runtimeId: 'r' }
const ok = (result: unknown) => ({ id: 'x', ok: true as const, result, _meta: meta })
const failed = {
  id: 'x',
  ok: false as const,
  error: { code: 'runtime_unavailable', message: 'down' },
  _meta: meta
}

describe('readMachineWorkAtRisk', () => {
  it('sums uncommitted entries and commits ahead across live worktrees on the server', async () => {
    const calls: string[] = []
    const work = await readMachineWorkAtRisk(async (method, params) => {
      calls.push(method)
      if (method === 'worktree.ps') {
        return ok({
          worktrees: [
            { worktreeId: 'w1' },
            { worktreeId: 'w2' },
            { worktreeId: 'w3', isArchived: true }
          ],
          truncated: false
        })
      }
      const worktree =
        typeof params === 'object' && params !== null && 'worktree' in params
          ? params.worktree
          : null
      return ok(
        worktree === 'id:w1'
          ? { entries: [{}, {}], upstreamStatus: { hasUpstream: true, ahead: 3 } }
          : {
              entries: [],
              didHitLimit: true,
              statusLength: 400,
              upstreamStatus: { hasUpstream: true, ahead: 0 }
            }
      )
    })
    expect(work).toEqual({ uncommitted: 402, unpushed: 3, neverPushed: 0 })
    expect(calls).toEqual(['worktree.ps', 'git.status', 'git.status'])
  })

  it('answers unknown when the list or any status cannot be read', async () => {
    expect(await readMachineWorkAtRisk(async () => failed)).toBeNull()
    expect(
      await readMachineWorkAtRisk(async (method) =>
        method === 'worktree.ps'
          ? ok({ worktrees: [{ worktreeId: 'w1' }], truncated: false })
          : failed
      )
    ).toBeNull()
    expect(
      await readMachineWorkAtRisk(async () => {
        throw new Error('tunnel closed')
      })
    ).toBeNull()
  })

  it('never reassures from an incomplete listing or a status without upstream data', async () => {
    const status = { entries: [], upstreamStatus: { hasUpstream: true, ahead: 0 } }
    // Past the listing cap: the rest of the machine's worktrees were never read.
    expect(
      await readMachineWorkAtRisk(async (method) =>
        method === 'worktree.ps'
          ? ok({ worktrees: [{ worktreeId: 'w1' }], truncated: true })
          : ok(status)
      )
    ).toBeNull()
    // An older host that does not say whether the listing is complete.
    expect(
      await readMachineWorkAtRisk(async (method) =>
        method === 'worktree.ps' ? ok({ worktrees: [{ worktreeId: 'w1' }] }) : ok(status)
      )
    ).toBeNull()
    // No upstream data (an older host, a detached HEAD): unpushed work is unknown, not zero.
    expect(
      await readMachineWorkAtRisk(async (method) =>
        method === 'worktree.ps'
          ? ok({ worktrees: [{ worktreeId: 'w1' }], truncated: false })
          : ok({ entries: [] })
      )
    ).toBeNull()
  })

  it('counts a branch with no upstream as never pushed', async () => {
    expect(
      await readMachineWorkAtRisk(async (method) =>
        method === 'worktree.ps'
          ? ok({ worktrees: [{ worktreeId: 'w1' }], truncated: false })
          : ok({ entries: [], upstreamStatus: { hasUpstream: false, ahead: 0 } })
      )
    ).toEqual({ uncommitted: 0, unpushed: 0, neverPushed: 1 })
  })
})
