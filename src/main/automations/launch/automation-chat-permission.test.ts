import { expect, it, vi } from 'vitest'
import { prepareAutomationFullAccess } from './automation-chat-permission'
import {
  createRestTestRig,
  REST_TEST_CALLER
} from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-rest-test-rig.test-fixture'
import {
  hostTestAttachParams,
  HOST_TEST_SESSION,
  HOST_TEST_NOW
} from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'

it('persists the shared conversation permission across host reconstruction', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(HOST_TEST_NOW)
  const rig = await createRestTestRig()
  try {
    const attached = await rig.host.attach(REST_TEST_CALLER, hostTestAttachParams(null))
    expect(attached.ok).toBe(true)
    expect(rig.store.getRecord(HOST_TEST_SESSION)?.permissionMode).not.toBe('full-access')
    await prepareAutomationFullAccess(rig.host, HOST_TEST_SESSION)
    await rig.restart()
    expect(rig.store.getRecord(HOST_TEST_SESSION)?.permissionMode).toBe('full-access')
    await prepareAutomationFullAccess(rig.host, HOST_TEST_SESSION)
    expect(rig.store.getRecord(HOST_TEST_SESSION)?.permissionMode).toBe('full-access')
  } finally {
    await rig.dispose()
    vi.restoreAllMocks()
  }
})
