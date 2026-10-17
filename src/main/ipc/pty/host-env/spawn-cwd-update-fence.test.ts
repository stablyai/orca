import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeTerminalAdmission,
  TerminalAdmissionClosedError
} from '../../../runtime/terminal-admission-fence'
import { assertWorkspaceAcceptsNewPty } from './spawn-cwd'

const { listLiveDaemonPtyIds } = vi.hoisted(() => ({
  listLiveDaemonPtyIds: vi.fn<() => Promise<string[] | null>>()
}))
vi.mock('../../../daemon/daemon-provider-state', () => ({ listLiveDaemonPtyIds }))

const accept = (worktreeId: string, sessionId?: string) =>
  Promise.resolve(assertWorkspaceAcceptsNewPty(undefined, worktreeId, sessionId))

afterEach(() => {
  closeTerminalAdmission(0)
  listLiveDaemonPtyIds.mockReset()
})

describe('assertWorkspaceAcceptsNewPty while an update closes admission (R32)', () => {
  it('admits terminals as before when admission is open', async () => {
    await expect(accept('repo-1::/x')).resolves.toBeUndefined()
    expect(listLiveDaemonPtyIds).not.toHaveBeenCalled()
  })

  it('refuses a new terminal once a census closed admission', async () => {
    closeTerminalAdmission(60_000)
    await expect(accept('repo-1::/x')).rejects.toBeInstanceOf(TerminalAdmissionClosedError)
  })

  it('still lets a client reattach a session the daemon runs', async () => {
    closeTerminalAdmission(60_000)
    listLiveDaemonPtyIds.mockResolvedValue(['repo-1::/x@@1'])
    await expect(accept('repo-1::/x', 'repo-1::/x@@1')).resolves.toBeUndefined()
  })

  it('refuses a reattach the daemon cannot vouch for', async () => {
    closeTerminalAdmission(60_000)
    listLiveDaemonPtyIds.mockResolvedValue(null)
    await expect(accept('repo-1::/x', 'repo-1::/x@@1')).rejects.toBeInstanceOf(
      TerminalAdmissionClosedError
    )
  })

  it('reopens on its own when the fence lapses', async () => {
    vi.useFakeTimers()
    try {
      closeTerminalAdmission(1_000)
      await expect(accept('repo-1::/x')).rejects.toBeInstanceOf(TerminalAdmissionClosedError)
      vi.advanceTimersByTime(1_001)
      await expect(accept('repo-1::/x')).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
