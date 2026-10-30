import { registerDaemonNativeFailureTests } from './daemon-server-native-failure.test-fixture'
import './mock-descendant-sweep'
import { expect, it, vi } from 'vitest'
import type { DaemonClient } from './client'
import type { createMockSubprocess } from './daemon-pty-adapter-test-harness'
import type { DaemonServer } from './daemon-server'
type DaemonServerInternals = {
  preparations: { pending: Map<string, Set<{ canceled: boolean }>> }
}
export type DaemonCreationFailureFixture = {
  directory: string
  server: DaemonServer
  client: DaemonClient
  subprocess: ReturnType<typeof createMockSubprocess>
  releaseSpawn: () => void
  spawnStarted: Promise<void>
  spawned: number
  nativePty: { spawn: ReturnType<typeof vi.fn> }
}
export function registerDaemonCreationFailureTests(fixture: DaemonCreationFailureFixture) {
  registerDaemonNativeFailureTests(fixture)
  it.each([
    ['observer', 'retry'],
    ['constructor', 'retry'],
    ['publication', 'disposal']
  ] as const)(
    'ordinary authenticated create drives failed unpublished cleanup: %s/%s',
    async (failure, wake) => {
      const options = {
        sessionId: 'ordinary-failed',
        cols: 80,
        rows: 24,
        agentSessionEnsure: {
          claim: {
            digestVersion: 1 as const,
            keyId: 'key',
            identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            agent: 'codex' as const
          },
          surface: {
            worktreeId: 'worktree',
            tabId: 'ordinary-tab',
            leafId: '11111111-1111-4111-8111-111111111111',
            terminalHandle: 'term_ordinary'
          }
        }
      }
      const creating = fixture.client.request('createOrAttach', options)
      const observed = expect(creating).rejects.toThrow('fixture subscription failed')
      await fixture.spawnStarted
      const failed = fixture.subprocess
      if (failure === 'observer') {
        failed.onExit = vi.fn(failed.onExit).mockImplementationOnce(() => {
          throw new Error('fixture subscription failed')
        })
      } else if (failure === 'constructor') {
        failed.onData = () => {
          throw new Error('fixture subscription failed')
        }
      } else {
        Object.assign(failed, {
          onInputClosed: () => {
            throw new Error('fixture subscription failed')
          }
        })
      }
      vi.mocked(failed.forceKill).mockImplementation(() => {
        throw new Error('fixture close unavailable')
      })
      fixture.releaseSpawn()
      await observed
      await vi.waitFor(() => expect(failed.forceKill).toHaveBeenCalled())
      expect(fixture.server.host.listSessions()).toEqual([])
      expect(fixture.server.automaticWork.gate.snapshot().terminals).toBe(1)
      const attempts = vi.mocked(failed.forceKill).mock.calls.length
      // The ordinary next authenticated request drives the retained resource, not a test callback.
      vi.mocked(failed.forceKill).mockImplementation(() => {
        setTimeout(() => failed._simulateExit(137), 5)
      })
      if (wake === 'disposal') {
        await fixture.server.host.dispose()
        expect(failed.dispose).toHaveBeenCalledOnce()
        expect(fixture.spawned).toBe(1)
        expect(fixture.server.automaticWork.gate.snapshot().terminals).toBe(0)
        return
      }
      expect(await fixture.client.request('createOrAttach', options)).toMatchObject({ isNew: true })
      expect(vi.mocked(failed.forceKill).mock.calls.length).toBeGreaterThan(attempts)
      expect(failed.dispose).toHaveBeenCalledOnce()
      expect(fixture.spawned).toBe(2)
      expect(fixture.server.automaticWork.gate.snapshot().terminals).toBe(1)
      await fixture.client.request('write', { sessionId: options.sessionId, data: 'new input' })
      expect(fixture.subprocess.write).toHaveBeenCalledWith('new input')
      await fixture.server.host.dispose()
      expect(fixture.server.automaticWork.gate.snapshot().terminals).toBe(0)
    }
  )

  it('matches a cancel for an attach-only request queued behind a hung create', async () => {
    const create = fixture.client.request('createOrAttach', {
      sessionId: 'shared-session',
      cols: 80,
      rows: 24
    })
    await fixture.spawnStarted
    const abort = new AbortController()
    const attach = fixture.client.request(
      'createOrAttach',
      { sessionId: 'shared-session', cols: 80, rows: 24, attachOnly: true },
      30_000,
      abort.signal
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inspect only the fixture receiver pending cancellation registrations.
    const daemon = fixture.server as unknown as {
      preparations: { pending: Map<string, Set<{ canceled: boolean }>> }
    }
    // Attach-only preparations must remain registered so cancellation can find them.
    await vi.waitFor(() => expect(daemon.preparations.pending.get('shared-session')?.size).toBe(2))

    abort.abort()
    await expect(attach).rejects.toThrow('client_disconnected')

    fixture.releaseSpawn()
    await expect(create).resolves.toMatchObject({ isNew: true })
  })
  it('does not cancel a sibling request for the same session id', async () => {
    const first = fixture.client.request('createOrAttach', {
      sessionId: 'shared-session',
      cols: 80,
      rows: 24
    })
    const abort = new AbortController()
    const second = fixture.client.request(
      'createOrAttach',
      { sessionId: 'shared-session', cols: 80, rows: 24 },
      30_000,
      abort.signal
    )
    await fixture.spawnStarted
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inspect only the fixture receiver pending map after its real spawn admission.
    const daemon = fixture.server as unknown as DaemonServerInternals
    await vi.waitFor(() => expect(daemon.preparations.pending.get('shared-session')?.size).toBe(2))

    abort.abort()
    await expect(second).rejects.toThrow('client_disconnected')
    fixture.releaseSpawn()

    await expect(first).resolves.toMatchObject({ isNew: true })
    expect(fixture.subprocess.forceKill).not.toHaveBeenCalled()
    await expect(fixture.client.request('listSessions', undefined)).resolves.toMatchObject({
      sessions: [expect.objectContaining({ sessionId: 'shared-session' })]
    })
  })
}
