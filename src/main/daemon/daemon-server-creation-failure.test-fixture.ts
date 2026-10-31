import './mock-descendant-sweep'
import { expect, it, vi } from 'vitest'
import type { DaemonClient } from './client'
import type { createMockSubprocess } from './daemon-pty-adapter-test-harness'
import type { DaemonServer } from './daemon-server'
export type DaemonCreationFailureFixture = {
  server: DaemonServer
  client: DaemonClient
  subprocess: ReturnType<typeof createMockSubprocess>
  releaseSpawn: () => void
  spawnStarted: Promise<void>
  spawned: number
}
export function registerDaemonCreationFailureTests(fixture: DaemonCreationFailureFixture) {
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
}
