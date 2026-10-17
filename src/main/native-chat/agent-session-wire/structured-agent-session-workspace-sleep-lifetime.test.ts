import { expect, it, vi } from 'vitest'
import { hostTestMessage } from './structured-agent-session-host-test-data'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'

it('omits an unverified stop superseded by a newer send while retaining a sibling receipt', async () => {
  const { host, store, acquire } = hostTestState()
  const record = await attach()
  if (!record) {
    throw new Error('attach did not produce a record')
  }
  const sibling = 'session-beta'
  const siblingRecord = { ...record, sessionId: sibling }
  const getRecord = store.getRecord.bind(store)
  vi.spyOn(store, 'listRecords').mockReturnValue([record, siblingRecord])
  vi.spyOn(store, 'getRecord').mockImplementation((id) =>
    id === sibling ? siblingRecord : getRecord(id)
  )
  host.deps.adapter.closeSession = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)

  let failedStopDone: () => void = () => undefined
  const failedStop = new Promise<void>((resolve) => {
    failedStopDone = resolve
  })
  let releaseSibling: () => void = () => undefined
  const slowSibling = new Promise<void>((resolve) => {
    releaseSibling = resolve
  })
  const close = host['lifetime'].closeForWorkspaceSleep
  vi.spyOn(host['lifetime'], 'closeForWorkspaceSleep').mockImplementation(async (...args) => {
    if (args[0] === sibling) {
      await slowSibling
      return { fence: siblingRecord.lease.runtimeFence, stopped: true }
    }
    const result = await close(...args)
    failedStopDone()
    return result
  })

  const sleeping = host.sleepWorkspace('workspace-1')
  try {
    await failedStop
    const body = hostTestMessage('resume after unverified stop')
    expect(
      await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    ).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(2))
  } finally {
    releaseSibling()
  }
  expect(await sleeping).toEqual({ stoppedSessionIds: [sibling] })
})
