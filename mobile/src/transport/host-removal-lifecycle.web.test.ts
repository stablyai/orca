import { describe, expect, it, vi } from 'vitest'

const removeHostMock = vi.hoisted(() => vi.fn())
const unregisterPushMock = vi.hoisted(() => vi.fn())
const saveRegistrationsMock = vi.hoisted(() => vi.fn())

vi.mock('./host-store', () => ({ removeHost: removeHostMock }))
vi.mock('../notifications/push-registration', () => ({
  unregisterPushForRemovedHost: unregisterPushMock
}))
vi.mock('../storage/preferences', () => ({
  saveRemotePushHostRegistrations: saveRegistrationsMock
}))

import { removeHostAndCloseClient } from './host-removal-lifecycle.web'
import {
  PAGE_HOST_REMOVAL_UNAVAILABLE_CODE,
  isPageHostRemovalUnavailable
} from './page-host-removal-refusal'

describe('removing a host from the page', () => {
  it('refuses with a code the screen can branch on', async () => {
    const error = await removeHostAndCloseClient('host-1', vi.fn()).catch(
      (reason: unknown) => reason
    )
    expect(isPageHostRemovalUnavailable(error)).toBe(true)
    expect({
      name: error instanceof Error ? error.name : null,
      code: isPageHostRemovalUnavailable(error) ? error.code : null
    }).toEqual({
      name: 'PageHostRemovalUnavailableError',
      code: PAGE_HOST_REMOVAL_UNAVAILABLE_CODE
    })
  })

  it('says where removal does work, rather than asking for a retry that cannot succeed', async () => {
    await expect(removeHostAndCloseClient('host-1', vi.fn())).rejects.toThrow(
      'Remove this host from the host list in the Orca app.'
    )
  })

  it('touches no store, no push subsystem and no client', async () => {
    // The page storage adapter drops writes and reports it, and push needs a device token this
    // document has none of: the refusal is what keeps either from being attempted at all.
    const forgetHostClient = vi.fn()
    await removeHostAndCloseClient('host-1', forgetHostClient).catch(() => {})
    expect({
      removeHost: removeHostMock.mock.calls.length,
      unregisterPush: unregisterPushMock.mock.calls.length,
      saveRegistrations: saveRegistrationsMock.mock.calls.length,
      forgetHostClient: forgetHostClient.mock.calls.length
    }).toEqual({ removeHost: 0, unregisterPush: 0, saveRegistrations: 0, forgetHostClient: 0 })
  })
})
