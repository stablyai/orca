import { describe, expect, it, vi } from 'vitest'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'

function createAdapter(sessionId: string, supported: boolean): DaemonPtyAdapter {
  const unsubscribe = () => {}
  return {
    listProcesses: vi.fn(async () => [{ id: sessionId, cwd: '', title: sessionId }]),
    supportsIncarnationAddressedShutdown: () => supported,
    onData: vi.fn(() => unsubscribe),
    onExit: vi.fn(() => unsubscribe),
    onDaemonIdentityChanged: vi.fn(() => unsubscribe)
  } as unknown as DaemonPtyAdapter
}

describe('daemon PTY router incarnation shutdown capability', () => {
  it('uses the adapter that owns the exact session', async () => {
    const current = createAdapter('current-session', true)
    const legacy = createAdapter('legacy-session', false)
    const router = new DaemonPtyRouter({ current, legacy: [legacy] })
    await router.discoverLegacySessions()

    expect(router.supportsIncarnationAddressedShutdown('current-session')).toBe(true)
    expect(router.supportsIncarnationAddressedShutdown('legacy-session')).toBe(false)
  })
})
