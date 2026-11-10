import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

const PTY_ID = 'repo-1::/tmp/wt@@7a3c9e01'

type LayoutInternals = {
  recordPtyWorktree: (ptyId: string, worktreeId: string, state?: { connected?: boolean }) => unknown
  enqueueLayout: (ptyId: string, target: unknown) => Promise<{ ok: boolean; reason?: string }>
  applyLayout: (ptyId: string, target: unknown) => Promise<{ ok: boolean; reason?: string }>
  freshSubscribeGuard: Set<string>
}

describe('layout queue when its PTY exits', () => {
  it('settles layout work queued behind the running slot as pty-exited', async () => {
    const runtime = new OrcaRuntimeService()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test reaches protected members the runtime defines.
    const internals = runtime as unknown as LayoutInternals
    internals.recordPtyWorktree(PTY_ID, 'repo-1::/tmp/wt', { connected: true })
    let finishRunning = (): void => {}
    vi.spyOn(internals, 'applyLayout').mockImplementation(
      () => new Promise((resolve) => (finishRunning = () => resolve({ ok: true })))
    )
    internals.freshSubscribeGuard.add(PTY_ID)
    const target = { kind: 'phone', cols: 40, rows: 20, ownerClientId: 'phone-1' }
    const running = internals.enqueueLayout(PTY_ID, target)
    const queued = internals.enqueueLayout(PTY_ID, { ...target, ownerClientId: 'phone-2' })

    await runtime.onPtyExit(PTY_ID, 0)
    finishRunning()

    await expect(running).resolves.toEqual({ ok: true })
    await expect(queued).resolves.toEqual({ ok: false, reason: 'pty-exited' })
  })
})
