import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import { LocalPtyProvider } from '../providers/local-pty/local-pty-provider'
import type { PtyProcessInfo } from '../providers/pty-provider-contract'
import { TerminalSessionOwnerUnverifiedError } from './daemon-errors'

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
  vi.restoreAllMocks()
})

function adapterFixture(label: string, pid: number) {
  const adapter = new DaemonPtyAdapter({
    socketPath: join(tmpdir(), `unused-${label}.sock`),
    tokenPath: join(tmpdir(), `unused-${label}.token`)
  })
  const client = adapter['client']
  vi.spyOn(client, 'ensureConnected').mockResolvedValue()
  vi.spyOn(client, 'ensureConnectedWithin').mockResolvedValue()
  const identity = vi.spyOn(client, 'getDaemonIdentity')
  const request = vi.spyOn(client, 'request').mockResolvedValue({ sessions: [] })
  const spawn = vi.spyOn(adapter, 'spawn').mockImplementation(async (opts) => ({
    id: opts.sessionId ?? 'unexpected-fresh-spawn',
    incarnationId: opts.expectedIncarnationId,
    isReattach: true
  }))
  return {
    adapter,
    request,
    spawn,
    setProcesses(processes: PtyProcessInfo[]) {
      request.mockResolvedValue({
        sessions: processes.map((process) => ({
          sessionId: process.id,
          incarnationId: process.incarnationId,
          cwd: process.cwd,
          isAlive: true
        }))
      })
    },
    async publishIdentity(generation: number) {
      identity.mockReturnValue({
        pid,
        startedAtMs: generation + 1,
        launchNonce: label + generation
      })
      await adapter.establishLifecycleLease()
    }
  }
}

async function fixture() {
  const current = adapterFixture('current', 999_999_997)
  const legacy = adapterFixture('legacy', 999_999_998)
  const fallback = new LocalPtyProvider()
  vi.spyOn(fallback, 'listProcesses').mockResolvedValue([])
  const provider = new DegradedDaemonPtyProvider({
    current: current.adapter,
    legacy: [legacy.adapter],
    fallback
  })
  cleanups.push(() => provider.dispose())
  await current.publishIdentity(0)
  await legacy.publishIdentity(0)
  const recovery = provider['ownerRecovery']
  return { current, legacy, provider, recovery }
}

function processInfo(id: string, incarnationId: string): PtyProcessInfo {
  return { id, incarnationId, cwd: '', title: 'shell' }
}

describe('shared daemon owner incarnation retirement', () => {
  it('retains authoritative incarnation mismatch refusal after another daemon changes', async () => {
    const { current, legacy, provider } = await fixture()
    legacy.setProcesses([processInfo('live', 'current-incarnation')])
    await provider.discoverDaemonSessions()
    await current.publishIdentity(1)
    await expect(
      provider.spawn({
        sessionId: 'live',
        attachOnly: true,
        cols: 80,
        rows: 24,
        expectedIncarnationId: 'retired-incarnation',
        expectedIncarnationIsAuthoritative: true
      })
    ).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
    expect(current.spawn).not.toHaveBeenCalled()
    expect(legacy.spawn).not.toHaveBeenCalled()
  })
})
