import { expect, it, vi } from 'vitest'
import type { PtySpawnResult } from '../providers/types'
import type { DaemonIdentityChangeEvent } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import { createAdapter, identity } from './daemon-pty-router-routing-safety-fixture'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import { createDaemonAdapter, createProvider } from './degraded-daemon-pty-provider-fixture'

it('rejects an existing-session spawn after its selected daemon is replaced', async () => {
  const sessionId = 'replaced-during-spawn'
  const legacy = createAdapter('legacy', [sessionId])
  const previous = identity('legacy', 10)
  const replacement = identity('legacy', 11)
  let resolveSpawn: ((result: { id: string }) => void) | undefined
  let markSpawnStarted: (() => void) | undefined
  const spawnStarted = new Promise<void>((resolve) => {
    markSpawnStarted = resolve
  })
  vi.mocked(legacy.adapter.spawn).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        markSpawnStarted?.()
        resolveSpawn = resolve
      })
  )
  const router = new DaemonPtyRouter({
    current: createAdapter('current').adapter,
    legacy: [legacy.adapter]
  })
  await router.discoverLegacySessions()

  const spawning = router.spawn({ sessionId, cols: 80, rows: 24 })
  await spawnStarted
  legacy.setIdentity(replacement)
  legacy.emitIdentityChange(previous, replacement)
  resolveSpawn?.({ id: sessionId })

  await expect(spawning).rejects.toThrow('daemon_session_routing_unavailable')
  expect(router.getSessionRouteState(sessionId)).toBe('unavailable')
})

it('rejects a degraded existing spawn after its selected daemon is replaced', async () => {
  const sessionId = 'replaced-daemon-spawn'
  const previous = { pid: 1, startedAtMs: 1, launchNonce: 'previous' }
  const replacement = { pid: 2, startedAtMs: 2, launchNonce: 'replacement' }
  const current = createDaemonAdapter('daemon', [sessionId])
  const fallback = createProvider('fallback')
  let daemonIdentity = previous
  let notifyIdentityChange!: (event: DaemonIdentityChangeEvent) => void
  vi.mocked(current.getLastAuthenticatedDaemonIdentity).mockImplementation(() => daemonIdentity)
  vi.mocked(current.onDaemonIdentityChanged).mockImplementation((listener) => {
    notifyIdentityChange = listener
    return () => {}
  })
  let resolveSpawn!: (result: PtySpawnResult) => void
  let markSpawnStarted!: () => void
  const spawnStarted = new Promise<void>((resolve) => {
    markSpawnStarted = resolve
  })
  vi.mocked(current.spawn).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        markSpawnStarted()
        resolveSpawn = resolve
      })
  )
  const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })
  await provider.discoverDaemonSessions()

  const spawning = provider.spawn({ sessionId, cols: 80, rows: 24 })
  await spawnStarted
  daemonIdentity = replacement
  notifyIdentityChange({ previous, current: replacement })
  resolveSpawn({ id: sessionId })

  await expect(spawning).rejects.toThrow('daemon_session_routing_unavailable')
})

it('rejects an existing fallback spawn when daemon ownership appears before its reply', async () => {
  const sessionId = 'fallback-owner-race'
  const current = createDaemonAdapter('daemon')
  const fallback = createProvider('fallback')
  const provider = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })
  await provider.spawn({ sessionId, isNewSession: true, cols: 80, rows: 24 })
  let resolveSpawn!: (result: PtySpawnResult) => void
  let markSpawnStarted!: () => void
  const spawnStarted = new Promise<void>((resolve) => {
    markSpawnStarted = resolve
  })
  vi.mocked(fallback.spawn).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        markSpawnStarted()
        resolveSpawn = resolve
      })
  )

  const spawning = provider.spawn({ sessionId, cols: 80, rows: 24 })
  await spawnStarted
  current.emitData(sessionId, 'daemon ownership')
  resolveSpawn({ id: sessionId })

  await expect(spawning).rejects.toThrow('daemon_session_routing_unavailable')
  expect(() => provider.write(sessionId, 'blocked')).toThrow('daemon_session_routing_unavailable')
})
