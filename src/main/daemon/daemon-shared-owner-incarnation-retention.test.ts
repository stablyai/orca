import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import { LocalPtyProvider } from '../providers/local-pty-provider'
import type { PtyProcessInfo } from '../providers/types'
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
  it('releases both private indexes after repeated authenticated daemon replacements', async () => {
    const { current, legacy, provider, recovery } = await fixture()
    legacy.setProcesses([processInfo('legacy-live', 'legacy-incarnation')])
    for (let generation = 0; generation < 16; generation++) {
      const id = `retired-${generation}`
      current.setProcesses([processInfo(id, `incarnation-${generation}`)])
      await provider.discoverDaemonSessions()
      await expect(provider.probePtyLiveness(`unmapped-${generation}`)).resolves.toBe(false)
      expect(recovery['livenessResolver']['routeIncarnations'].get(id)).toBe(
        `incarnation-${generation}`
      )
      current.setProcesses([])
      await current.publishIdentity(generation + 1)
      expect([...provider['sessionProviders'].keys()]).toEqual(['legacy-live'])
      expect([...recovery['attachResolver']['routeIncarnations'].keys()]).toEqual(['legacy-live'])
      expect([...recovery['livenessResolver']['routeIncarnations'].keys()]).toEqual(['legacy-live'])
    }
  })

  it('preserves the same session ID after another provider publishes its successor', async () => {
    const { current, legacy, provider, recovery } = await fixture()
    current.setProcesses([processInfo('same-id', 'old-incarnation')])
    await provider.discoverDaemonSessions()
    await provider.probePtyLiveness('unmapped-old')
    current.setProcesses([])
    legacy.setProcesses([processInfo('same-id', 'new-incarnation')])
    await provider.discoverDaemonSessions()
    await provider.probePtyLiveness('unmapped-new')
    await current.publishIdentity(1)
    expect(provider['sessionProviders'].get('same-id')).toBe(legacy.adapter)
    expect(recovery['attachResolver']['routeIncarnations'].get('same-id')).toBe('new-incarnation')
    expect(recovery['livenessResolver']['routeIncarnations'].get('same-id')).toBe('new-incarnation')
  })

  it('keeps matching-incarnation direct attach without consulting another inventory', async () => {
    const { current, legacy, provider } = await fixture()
    legacy.setProcesses([processInfo('live', 'live-incarnation')])
    await provider.discoverDaemonSessions()
    await provider.probePtyLiveness('unmapped')
    await current.publishIdentity(1)
    current.request.mockClear()
    legacy.request.mockClear()
    await expect(
      provider.spawn({
        sessionId: 'live',
        attachOnly: true,
        cols: 80,
        rows: 24,
        expectedIncarnationId: 'live-incarnation',
        expectedIncarnationIsAuthoritative: true
      })
    ).resolves.toMatchObject({ id: 'live', incarnationId: 'live-incarnation', isReattach: true })
    expect(current.request).not.toHaveBeenCalled()
    expect(legacy.request).not.toHaveBeenCalled()
    expect(current.spawn).not.toHaveBeenCalled()
    expect(legacy.spawn).toHaveBeenCalledOnce()
  })

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
