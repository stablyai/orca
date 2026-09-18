import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost } from './terminal-host'
import { SessionNotFoundError } from './types'

type MockSubprocess = SubprocessHandle & { exit(code: number): void }

function createSubprocess(): MockSubprocess {
  let onExit: ((code: number) => void) | null = null
  return {
    pid: 99_999,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => onExit?.(0)),
    terminateOwnedTree: () => 'unavailable',
    forceKill: vi.fn(() => onExit?.(137)),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit: (callback) => {
      onExit = callback
    },
    dispose: vi.fn(),
    exit: (code: number) => onExit?.(code)
  } as MockSubprocess
}

function createHost(): { host: TerminalHost; lastSubprocess: () => MockSubprocess } {
  let last: MockSubprocess | undefined
  const host = new TerminalHost({
    spawnSubprocess: () => {
      last = createSubprocess()
      return last
    }
  })
  return { host, lastSubprocess: () => last as MockSubprocess }
}

describe('TerminalHost process inspection', () => {
  it('returns unverifiable when the expected incarnation is stale', async () => {
    const host = new TerminalHost({ spawnSubprocess: () => createSubprocess() })
    try {
      const created = await host.createOrAttach({
        sessionId: 'session-incarnation',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      await expect(
        host.inspectProcess('session-incarnation', { expectedIncarnationId: 'replacement' })
      ).resolves.toMatchObject({
        foregroundProcessEvidence: {
          verdict: 'unverifiable',
          reason: 'incarnation_mismatch',
          ptyId: 'session-incarnation',
          ptyIncarnationId: created.incarnationId
        }
      })
    } finally {
      await host.dispose()
    }
  })
})

describe('TerminalHost undelivered exits', () => {
  /** Orca quits (the client's attachments drop), the shell ends, Orca reopens and asks. */
  async function exitWhileClientIsAway(
    host: TerminalHost,
    subprocess: () => MockSubprocess,
    sessionId: string,
    code = 0
  ): Promise<string> {
    const created = await host.createOrAttach({
      sessionId,
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    host.detach(sessionId, created.attachToken as symbol)
    subprocess().exit(code)
    return created.incarnationId
  }

  it('answers during exit broadcast and retains the same proof after reaping', async () => {
    const { host, lastSubprocess } = createHost()
    let proofDuringBroadcast: ReturnType<TerminalHost['inspectProcess']> | undefined
    let incarnationId = ''
    try {
      const created = await host.createOrAttach({
        sessionId: 'broadcast-exit',
        cols: 80,
        rows: 24,
        streamClient: {
          onData: vi.fn(),
          onExit: () => {
            proofDuringBroadcast = host.inspectProcess('broadcast-exit', {
              expectedIncarnationId: incarnationId
            })
          }
        }
      })
      incarnationId = created.incarnationId
      lastSubprocess().exit(17)
      const expected = {
        foregroundProcessEvidence: {
          verdict: 'exited',
          ptyIncarnationId: incarnationId,
          reason: 'pty_exit_17'
        }
      }
      await expect(proofDuringBroadcast).resolves.toMatchObject(expected)
      await expect(
        host.inspectProcess('broadcast-exit', { expectedIncarnationId: incarnationId })
      ).resolves.toMatchObject(expected)
    } finally {
      await host.dispose()
    }
  })

  it('keeps handing a close-and-reopen caller the exit its client never received', async () => {
    const { host, lastSubprocess } = createHost()
    try {
      const incarnationId = await exitWhileClientIsAway(host, lastSubprocess, 'session-away', 3)

      // The exit is gone from every liveness surface, but the evidence is still owed to its owner.
      expect(host.listSessions()).toHaveLength(0)
      await expect(
        host.inspectProcess('session-away', { expectedIncarnationId: incarnationId })
      ).resolves.toMatchObject({
        foregroundProcess: null,
        hasChildProcesses: false,
        foregroundProcessEvidence: {
          ptyId: 'session-away',
          ptyIncarnationId: incarnationId,
          verdict: 'exited',
          reason: 'pty_exit_3'
        }
      })

      // Reading is not delivery: a sweep that reads the proof and then fails to persist the
      // settlement must find it again next time.
      await expect(
        host.inspectProcess('session-away', { expectedIncarnationId: incarnationId })
      ).resolves.toMatchObject({ foregroundProcessEvidence: { verdict: 'exited' } })
    } finally {
      await host.dispose()
    }
  })

  it('answers nothing to a caller with the wrong incarnation or none at all', async () => {
    const { host, lastSubprocess } = createHost()
    try {
      const incarnationId = await exitWhileClientIsAway(host, lastSubprocess, 'session-away')

      expect(() =>
        host.inspectProcess('session-away', { expectedIncarnationId: 'someone-else' })
      ).toThrow(SessionNotFoundError)
      expect(() => host.inspectProcess('session-away')).toThrow(SessionNotFoundError)

      // Neither refusal consumed the evidence the real owner is still owed.
      await expect(
        host.inspectProcess('session-away', { expectedIncarnationId: incarnationId })
      ).resolves.toMatchObject({ foregroundProcessEvidence: { verdict: 'exited' } })
    } finally {
      await host.dispose()
    }
  })

  it('still answers an exit that was broadcast to an attached client', async () => {
    const { host, lastSubprocess } = createHost()
    try {
      const onExit = vi.fn()
      const created = await host.createOrAttach({
        sessionId: 'session-attached',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit }
      })
      lastSubprocess().exit(0)

      // Broadcast is not the record's lifecycle: whether anyone was listening, the exited session
      // stays answerable to a caller naming its exact incarnation.
      expect(onExit).toHaveBeenCalledWith(0, created.incarnationId, expect.anything())
      expect(host.listSessions()).toHaveLength(0)
      await expect(
        host.inspectProcess('session-attached', { expectedIncarnationId: created.incarnationId })
      ).resolves.toMatchObject({
        foregroundProcessEvidence: {
          ptyId: 'session-attached',
          ptyIncarnationId: created.incarnationId,
          verdict: 'exited',
          reason: 'pty_exit_0'
        }
      })
      expect(() => host.inspectProcess('session-attached')).toThrow(SessionNotFoundError)
    } finally {
      await host.dispose()
    }
  })

  it('does not let a session recreated under the same id inherit the old exit', async () => {
    const { host, lastSubprocess } = createHost()
    try {
      const incarnationId = await exitWhileClientIsAway(host, lastSubprocess, 'session-reused')
      const replacement = await host.createOrAttach({
        sessionId: 'session-reused',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      expect(replacement.incarnationId).not.toBe(incarnationId)
      await expect(
        host.inspectProcess('session-reused', { expectedIncarnationId: incarnationId })
      ).resolves.toMatchObject({
        foregroundProcessEvidence: { verdict: 'unverifiable', reason: 'incarnation_mismatch' }
      })
    } finally {
      await host.dispose()
    }
  })

  it('drops the record of a session its owner killed, even with no client attached', async () => {
    const { host, lastSubprocess } = createHost()
    try {
      const created = await host.createOrAttach({
        sessionId: 'session-killed',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      host.detach('session-killed', created.attachToken as symbol)
      await host.kill('session-killed')
      lastSubprocess().exit(0)

      // The owner asked for this exit; there is nothing left to tell it, so nothing is retained.
      expect(() =>
        host.inspectProcess('session-killed', { expectedIncarnationId: created.incarnationId })
      ).toThrow(SessionNotFoundError)
    } finally {
      await host.dispose()
    }
  })

  it('drops a held exit once its owner kills the session it belonged to', async () => {
    const { host, lastSubprocess } = createHost()
    try {
      const incarnationId = await exitWhileClientIsAway(host, lastSubprocess, 'session-away')
      await expect(
        host.inspectProcess('session-away', { expectedIncarnationId: incarnationId })
      ).resolves.toMatchObject({ foregroundProcessEvidence: { verdict: 'exited' } })

      // Nothing killed the process; the owner is telling the host it has acted on the exit.
      await expect(
        host.kill('session-away', { expectedIncarnationId: incarnationId })
      ).resolves.toBeUndefined()
      expect(() =>
        host.inspectProcess('session-away', { expectedIncarnationId: incarnationId })
      ).toThrow(SessionNotFoundError)
      expect(() => host.kill('session-never')).toThrow(SessionNotFoundError)
    } finally {
      await host.dispose()
    }
  })

  it('refuses to end a newer shell when the owner releases an older incarnation', async () => {
    const { host, lastSubprocess } = createHost()
    try {
      const older = await exitWhileClientIsAway(host, lastSubprocess, 'session-reused')
      // The pane respawned onto its stable id before the owner settled the old exit.
      const replacement = await host.createOrAttach({
        sessionId: 'session-reused',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      const live = lastSubprocess()

      expect(() => host.kill('session-reused', { expectedIncarnationId: older })).toThrow(
        'PTY incarnation mismatch'
      )
      expect(live.kill).not.toHaveBeenCalled()
      expect(live.forceKill).not.toHaveBeenCalled()
      expect(host.listSessions()).toMatchObject([
        { sessionId: 'session-reused', incarnationId: replacement.incarnationId, isAlive: true }
      ])
    } finally {
      await host.dispose()
    }
  })

  it('keeps a session the owner kills mid-exit out of the retained set', async () => {
    const { host } = createHost()
    try {
      const created = await host.createOrAttach({
        sessionId: 'session-immediate',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      host.detach('session-immediate', created.attachToken as symbol)
      await host.kill('session-immediate', { immediate: true })

      expect(() =>
        host.inspectProcess('session-immediate', { expectedIncarnationId: created.incarnationId })
      ).toThrow(SessionNotFoundError)
      expect(host.listSessions()).toHaveLength(0)
    } finally {
      await host.dispose()
    }
  })
})
