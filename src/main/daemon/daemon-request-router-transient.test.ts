import { expect, it, vi } from 'vitest'
import { DaemonRequestRouter } from './daemon-request-router'

it('refuses fresh transient probes during retirement but permits owner cleanup', async () => {
  const transientRoute = vi.fn(() => ({}))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only transient routing is exercised, using these three dependencies exclusively.
  const options = {
    connections: { get: () => ({ authenticatedPairEstablished: true, streamSocket: {} }) },
    lifecycle: { isAcceptingWork: () => false },
    transientPtys: { route: transientRoute }
  } as unknown as ConstructorParameters<typeof DaemonRequestRouter>[0]
  const router = new DaemonRequestRouter(options)
  await expect(
    router.route('owner', {
      id: 'create',
      type: 'createTransientPty',
      payload: { id: 'probe', file: '/tool', args: [], env: {}, cwd: '/tmp', cols: 80, rows: 24 }
    })
  ).rejects.toThrow('shutting down')
  expect(transientRoute).not.toHaveBeenCalled()
  await expect(
    router.route('owner', { id: 'close', type: 'closeTransientPty', payload: { id: 'probe' } })
  ).resolves.toEqual({})
  expect(transientRoute).toHaveBeenCalledOnce()
})
