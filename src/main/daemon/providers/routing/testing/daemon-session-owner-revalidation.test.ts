import { expect, it, onTestFinished, vi } from 'vitest'
import { DaemonPtyAdapter } from '../../adapter/daemon-pty-adapter'
import type { PtyProcessInfo } from '../../../../providers/pty/process-info'
import { LocalPtyProvider } from '../../../../providers/local-pty/local-pty-provider'
import { DaemonSessionOwnerResolver } from '../daemon-session-owner-resolution'
import { DegradedDaemonOwnerRecovery } from '../degraded-daemon-owner-recovery'

it('confirms the route with a new inventory when an earlier one is partly sampled', async () => {
  const current = new DaemonPtyAdapter({ socketPath: 'current-socket', tokenPath: 'current-token' })
  const legacy = new DaemonPtyAdapter({ socketPath: 'legacy-socket', tokenPath: 'legacy-token' })
  onTestFinished(() => {
    current.dispose()
    legacy.dispose()
  })
  const firstCurrentSample = Promise.withResolvers<void>()
  const firstLegacySample = Promise.withResolvers<PtyProcessInfo[]>()
  const currentSample = vi.spyOn(current, 'listProcesses').mockImplementationOnce(async () => {
    firstCurrentSample.resolve()
    return [{ id: 'pty-1', cwd: '', title: 'fixture', incarnationId: 'incarnation-1' }]
  })
  vi.spyOn(legacy, 'listProcesses')
    .mockReturnValueOnce(firstLegacySample.promise)
    .mockResolvedValue([])
  const resolver = new DaemonSessionOwnerResolver([current, legacy], new Map())
  resolver.recordRoute('pty-1', current, 'incarnation-1')

  const earlier = resolver.listProcesses()
  await firstCurrentSample.promise
  currentSample.mockRejectedValue(new Error('current provider is unavailable'))
  const revalidation = resolver.revalidateTermination('pty-1', 'incarnation-1', current)
  firstLegacySample.resolve([])

  await expect(revalidation).rejects.toThrow('terminal_pane_owner_unverified')
  await expect(earlier).resolves.toMatchObject([{ id: 'pty-1', incarnationId: 'incarnation-1' }])
})

it('refuses to treat degraded inventory as proof that a daemon terminal exited', async () => {
  const fallback = new LocalPtyProvider()
  const router = new DegradedDaemonOwnerRecovery([fallback], [], new Map(), async () => {
    throw new Error('unexpected spawn')
  })
  await expect(
    router.killFenced(
      {
        id: 'unreachable-daemon-pty',
        expectedIncarnationId: 'known-incarnation',
        requireNoAgentOwner: false,
        requireUnattached: false,
        keepHistory: true
      },
      () => {}
    )
  ).resolves.toEqual({ outcome: 'refused', reason: 'unverifiable' })
})

it('rejects a route invalidated after departure from inventory and before wire dispatch', async () => {
  const provider = new DaemonPtyAdapter({ socketPath: 'test-socket', tokenPath: 'test-token' })
  onTestFinished(() => provider.dispose())
  vi.spyOn(provider, 'listProcesses').mockResolvedValue([
    { id: 'pty-1', cwd: '', title: 'fixture', incarnationId: 'incarnation-1' }
  ])
  const resolver = new DaemonSessionOwnerResolver([provider], new Map())
  const authorize = await resolver.revalidateTermination('pty-1', 'incarnation-1', provider)
  if (typeof authorize !== 'function') {
    throw new Error('expected a verified live route')
  }
  resolver.invalidateProvider(provider)
  expect(authorize).toThrow('terminal_pane_owner_unverified')
})
