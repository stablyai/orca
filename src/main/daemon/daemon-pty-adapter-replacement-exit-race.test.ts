import { fixture } from '../persistence/loading-store/profile-state-delayed-authority-fixture'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { adoptStablePane } from '../ipc/pty/pane/adopt-stable'
import { setLocalPtyProvider } from '../ipc/pty/provider/registry'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { formatTerminalStartFailure } from '../../shared/terminal-start-failure'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'

describe('DaemonPtyAdapter replacement exit races', () => {
  let adapter: DaemonPtyAdapter
  let server: Awaited<ReturnType<typeof startDaemonAdapterHarness>>['server']
  let tempDir: string
  let lastSubprocess: ReturnType<typeof createMockSubprocess>

  beforeEach(async () => {
    const harness = await startDaemonAdapterHarness(() => {
      lastSubprocess = createMockSubprocess()
      return lastSubprocess
    })
    adapter = harness.adapter
    server = harness.server
    tempDir = harness.dir
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it.each([false, true])(
    'captures a replacement exit with stale cache (production adoption: %s)',
    async (adoption) => {
      const sessionId = 'replacement-exit-with-stale-incarnation-cache'
      const internals = adapter as unknown as {
        activeSessionIds: Set<string>
        sessionIncarnations: Map<string, string>
        pendingSpawnOperationsBySessionId: Map<
          string,
          Set<{ exitsBySessionId: Map<string, unknown[]> }>
        >
        client: { request: (type: string, payload?: unknown) => Promise<unknown> }
      }
      const { store } = await fixture()
      const runtime = new OrcaRuntimeService(store)
      const pane = {
        worktreeId: 'repo-local::/fixture/local',
        tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      }
      if (adoption) {
        await adapter.spawn({ cols: 80, rows: 24, sessionId })
        await store.persistPtyBinding({
          ...pane,
          ptyId: sessionId,
          incarnationId: 'incarnation-from-crashed-daemon'
        })
        setLocalPtyProvider(adapter)
      }
      const spawn = vi.spyOn(adapter, 'spawn')
      internals.activeSessionIds.add(sessionId)
      internals.sessionIncarnations.set(sessionId, 'incarnation-from-crashed-daemon')
      const originalRequest = internals.client.request.bind(internals.client)
      vi.spyOn(internals.client, 'request').mockImplementation(
        async (type: string, payload?: unknown) => {
          const response = await originalRequest(type, payload)
          if (type === 'createOrAttach') {
            lastSubprocess._simulateExit(256, {
              kind: 'exited',
              exitCode: 256,
              initialOutputDiagnostic: 'git-bash-console-capacity'
            })
            await waitFor(() =>
              [...(internals.pendingSpawnOperationsBySessionId.get(sessionId) ?? [])].some(
                (operation) => (operation.exitsBySessionId.get(sessionId)?.length ?? 0) > 0
              )
            )
          }
          return response
        }
      )

      if (adoption) {
        const error = await adoptStablePane(runtime, store, { ...pane, cols: 80, rows: 24 }).catch(
          (caught: unknown) => caught
        )
        expect(error).toMatchObject({ message: 'agent_session_exited_during_start' })
        expect(formatTerminalStartFailure(error)).toBeUndefined()
        expect(() =>
          runtime.resolveTerminalPane(`${pane.tabId}:${pane.leafId}`, pane.worktreeId)
        ).toThrow('terminal_not_found')
      } else {
        await adapter.spawn({ cols: 80, rows: 24, sessionId })
      }
      const result = await spawn.mock.results[0].value

      expect(result).toMatchObject({
        incarnationId: expect.any(String),
        exitedBeforeSpawnReply: true,
        exitCause: {
          kind: 'exited',
          exitCode: 256,
          initialOutputDiagnostic: 'git-bash-console-capacity'
        }
      })
      expect(internals.activeSessionIds.has(sessionId)).toBe(false)
      expect(internals.sessionIncarnations.has(sessionId)).toBe(false)
      expect(internals.pendingSpawnOperationsBySessionId.has(sessionId)).toBe(false)
    }
  )
})
