import {
  createRouteDeclarationFixture,
  routeDeclarationPorts
} from './push-route-declaration-ports.test-fixture'
import { expect, it, vi } from 'vitest'
import * as SecureStore from 'expo-secure-store'

const fixture = createRouteDeclarationFixture()
const state = routeDeclarationPorts()
it('publishes exact metadata commits, preserves them through later credential failure, and isolates observer errors', async () => {
  const routeHint = vi.spyOn(fixture.publisher, 'refreshPushRoutes')
  const store = await import('../transport/host-store')
  const metadata = await import('../transport/host-metadata-store')
  const first = (await metadata.readStoredHostProfilesForMutation()).at(0)
  if (!first) {
    throw new Error('Missing stored host')
  }
  await store.updateLastConnected(first.id)
  await store.updateHostNameAndEndpoint(first.id, { personalName: 'Local name' })
  expect(routeHint).not.toHaveBeenCalled()
  vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('credential write failed'))
  await expect(
    store.savePairedHost({ ...first, name: 'Committed name', deviceToken: 'new-token' })
  ).rejects.toThrow()
  expect(routeHint).toHaveBeenCalledOnce()
  expect(routeHint.mock.calls.at(-1)?.[0]).toMatchObject({
    status: 'committed',
    profiles: expect.arrayContaining([expect.objectContaining({ id: first.id })])
  })
  routeHint.mockClear()
  const storage = (await import('@react-native-async-storage/async-storage')).default
  vi.spyOn(storage, 'setItem').mockRejectedValueOnce(new Error('ambiguous metadata write'))
  await expect(store.removeHost(first.id)).rejects.toThrow('ambiguous metadata write')
  expect(routeHint.mock.calls).toEqual([[{ status: 'unavailable' }]])
  routeHint.mockImplementationOnce(() => {
    throw new Error('route bookkeeping failed')
  })
  await expect(store.removeHost(first.id)).resolves.toBeUndefined()
  expect(state.storage.get('orca:hosts')).toBe('[]')
})
