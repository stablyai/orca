import { describe, expect, it, vi } from 'vitest'
import { SSH_TERMINATE_RECONNECT_REQUIRED } from '../../shared/constants'
import type { SshManagedServerStatus, SshTarget } from '../../shared/ssh-types'

vi.mock('./ssh-connect-flow', () => ({ connectTarget: vi.fn() }))
vi.mock('./ssh-terminate-sessions', () => ({ terminateSshTargetSessions: vi.fn() }))
vi.mock('./ssh-session-teardown', () => ({ teardownSshTargetTransport: vi.fn() }))

const { moveSshHostToManagedServer } = await import('./ssh-managed-server-move')

const target: SshTarget = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }
const live = (terminals: number): SshManagedServerStatus => ({
  kind: 'relay',
  reason: 'relay_terminals_live',
  terminals
})

/** `afterConnect` is what the reconnect's own decision (and its census) recorded. */
function deps(options: { unverifiable?: number; afterConnect?: SshManagedServerStatus } = {}) {
  const calls: string[] = []
  let status: SshManagedServerStatus | undefined = live(2)
  return {
    calls,
    getTarget: vi.fn(() => target),
    terminate: vi.fn(async (_targetId: string, _onStopped: (appPtyId: string) => void) => {
      calls.push('terminate')
      return { terminated: 2, unverifiable: options.unverifiable ?? 0 }
    }),
    connect: vi.fn(async () => {
      calls.push('connect')
      status = options.afterConnect ?? { kind: 'managed', environmentId: 'env-1' }
    }),
    serverStatus: vi.fn(() => status),
    report: vi.fn(),
    releaseRelay: vi.fn(async () => {
      calls.push('release')
    })
  }
}

describe('moving an SSH host to its managed server on request', () => {
  it('names the shells it stopped, even when a later stop fails, so only those tabs restart', async () => {
    const move = deps({ afterConnect: live(1) })
    move.terminate.mockImplementationOnce(async (_targetId, onStopped) => {
      onStopped('ssh:ssh-1@@pty-1')
      throw new Error('Failed to terminate SSH host sessions: pty-2: mux down')
    })
    await expect(moveSshHostToManagedServer('ssh-1', move)).resolves.toEqual({
      outcome: 'refused',
      verdict: 'live',
      terminals: 1,
      stoppedPtyIds: ['ssh:ssh-1@@pty-1']
    })
  })

  it('stops the relay terminals, then lets the reconnect prove them exited and convert', async () => {
    const move = deps()
    await expect(moveSshHostToManagedServer('ssh-1', move)).resolves.toEqual({
      outcome: 'moved',
      environmentId: 'env-1'
    })
    // No census of its own: the connect's decision runs it while holding the raw 'connected'.
    expect(move.calls).toEqual(['terminate', 'connect'])
    expect(move.report).toHaveBeenCalledWith('ssh-1', 'moved')
  })

  it('refuses without converting when the stop could not reach every terminal', async () => {
    const move = deps({
      unverifiable: 1,
      afterConnect: { kind: 'relay', reason: 'relay_terminals_unverifiable', terminals: 1 }
    })
    await expect(moveSshHostToManagedServer('ssh-1', move)).resolves.toEqual({
      outcome: 'refused',
      verdict: 'unverifiable',
      terminals: 1
    })
    expect(move.report).toHaveBeenCalledWith('ssh-1', 'refused_unverifiable')
  })

  it('reports the reconnect census verdict when it keeps the relay', async () => {
    const stillLive = deps({ afterConnect: live(1) })
    await expect(moveSshHostToManagedServer('ssh-1', stillLive)).resolves.toEqual({
      outcome: 'refused',
      verdict: 'live',
      terminals: 1
    })
    expect(stillLive.report).toHaveBeenCalledWith('ssh-1', 'refused_live')

    const unproven = deps({
      afterConnect: { kind: 'relay', reason: 'relay_terminals_unverifiable', terminals: 3 }
    })
    await expect(moveSshHostToManagedServer('ssh-1', unproven)).resolves.toEqual({
      outcome: 'refused',
      verdict: 'unverifiable',
      terminals: 3
    })
  })

  it('reports a connect that kept the relay for another reason', async () => {
    const move = deps({ afterConnect: { kind: 'relay', reason: 'refused', detail: 'blocked' } })
    await expect(moveSshHostToManagedServer('ssh-1', move)).resolves.toEqual({ outcome: 'stayed' })
    expect(move.report).toHaveBeenCalledWith('ssh-1', 'stayed')
  })

  it('reattaches the relay first when preserved terminals need one to be stopped', async () => {
    const move = deps()
    move.terminate.mockRejectedValueOnce(
      new Error(`${SSH_TERMINATE_RECONNECT_REQUIRED}: reconnect`)
    )
    await expect(moveSshHostToManagedServer('ssh-1', move)).resolves.toMatchObject({
      outcome: 'moved'
    })
    expect(move.calls).toEqual(['connect', 'terminate', 'connect'])
  })

  it('detaches a relay a failed stop left up, so the reconnect decides again', async () => {
    const move = deps()
    // BUG-15: the second terminal's reply was lost to a relay that hung up on its last exit.
    move.terminate.mockRejectedValueOnce(
      new Error('Failed to terminate SSH host sessions: pty2:a:3: Multiplexer disposed')
    )
    await expect(moveSshHostToManagedServer('ssh-1', move)).resolves.toMatchObject({
      outcome: 'moved'
    })
    expect(move.calls).toEqual(['release', 'connect'])
  })

  it('leaves the relay of a stop that succeeded to the reconnect', async () => {
    const move = deps()
    await moveSshHostToManagedServer('ssh-1', move)
    expect(move.releaseRelay).not.toHaveBeenCalled()
  })

  it('reports the stop’s own unverifiable count when the reconnect itself fails', async () => {
    const move = deps({ unverifiable: 2 })
    move.connect.mockRejectedValueOnce(new Error('auth failed'))
    await expect(moveSshHostToManagedServer('ssh-1', move)).resolves.toEqual({
      outcome: 'refused',
      verdict: 'unverifiable',
      terminals: 2
    })
  })
})
