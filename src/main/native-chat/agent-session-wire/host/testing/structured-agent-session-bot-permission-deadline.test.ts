import { expect, it, vi } from 'vitest'
import { codexNativeResumeRequirement } from '../../../../codex/structured/turns/codex-structured-turn-permission'
import type { CodexSession } from '../../../../codex/structured/session-lifecycle/codex-structured-session-state'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestSendParams
} from './structured-agent-session-host-test-data.test-fixture'
import {
  accept,
  acquire,
  dispatch,
  eventually,
  host,
  providerOpen,
  proveOpen,
  publishFirst,
  registerStartupAttemptHostTests,
  restartWith,
  submission,
  store,
  closeSession,
  CALLER
} from './structured-agent-session-startup-attempt-host-test-support'

registerStartupAttemptHostTests()

async function currentBotReceipt() {
  const seed = await accept('seed rollout')
  await proveOpen()
  await eventually(async () => expect((await submission(seed))?.dispatchState).toBe('accepted'))
  await restartWith(publishFirst, { botHome: true, supportsGoals: true })
  const ready = await accept('establish current policy under Ask')
  await proveOpen()
  await eventually(async () => expect((await submission(ready))?.dispatchState).toBe('accepted'))
  expect(store.getRecord(SESSION)?.instructionPolicy).toMatchObject({ state: 'delivered' })
  const providerSession: Pick<CodexSession, 'permissions'> = {
    permissions: {
      acquiredMode: 'ask',
      appliedMode: 'ask',
      launchSandboxIntact: true,
      cwd: '/disposable/workspace'
    }
  }
  host.deps.adapter.permissionModeRequiresAcquisition = codexNativeResumeRequirement(
    new Map([[SESSION, providerSession]])
  )
  await store.updateRecord(SESSION, {
    kind: 'options',
    args: {
      sessionId: SESSION,
      fence: store.getRecord(SESSION)!.lease.runtimeFence,
      permissionMode: 'own',
      now: Date.now()
    }
  })
  dispatch.mockClear()
  return providerSession
}

it('bounds the actual Ask-to-own cold retirement with a current bot receipt and never writes late A', async () => {
  const provider = await currentBotReceipt()
  let release!: (exited: boolean) => void
  const closed = new Promise<boolean>((resolve) => {
    release = resolve
  })
  closeSession.mockImplementation(() => closed)
  try {
    const a = await accept('permission recovery A')
    await vi.advanceTimersByTimeAsync(9_000)
    expect(await submission(a)).toMatchObject({ dispatchState: 'pending' })
    await vi.advanceTimersByTimeAsync(2_000)
    await eventually(async () =>
      expect(await submission(a)).toMatchObject({
        dispatchState: 'rejected',
        rejection: { instructionRecovery: 'timeout', neverReachedAgent: true }
      })
    )
    expect(store.getRecord(SESSION)?.lease.claimStatus).not.toBe('released')
    const b = await accept('B waits for real writer release')
    await vi.advanceTimersByTimeAsync(11_000)
    await eventually(async () =>
      expect(await submission(b)).toMatchObject({
        dispatchState: 'rejected',
        rejection: { neverReachedAgent: true }
      })
    )
    release(true)
    await host.flushStreamedEvents(SESSION)
    const c = await accept('C after proven release')
    await eventually(() => expect(providerOpen.mock.calls.length).toBe(2))
    provider.permissions!.acquiredMode = 'own'
    provider.permissions!.appliedMode = 'own'
    await proveOpen()
    await eventually(async () => expect((await submission(c))?.dispatchState).toBe('accepted'))
    expect(dispatch.mock.calls.map((call) => call[0].clientMessageId)).toEqual([c])
    expect(await submission(a)).toMatchObject({ dispatchState: 'rejected' })
  } finally {
    release(true)
    closeSession.mockResolvedValue(true)
  }
})

it('excludes an accepted active task from permission-recovery retirement and its deadline', async () => {
  await currentBotReceipt()
  const events = acquire.mock.calls.at(-1)![0].events!
  events.appendItem(
    { provider: 'codex', threadId: 'thread-alpha', turnId: 'working', ordinal: 50 },
    { kind: 'turn', turnId: 'working', state: 'running' },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await host.flushStreamedEvents(SESSION)
  const b = hostTestSendParams('queued while accepted work runs')
  expect(await host.send(CALLER, b)).toMatchObject({
    ok: true,
    value: { queued: { state: 'waiting' } }
  })
  await vi.advanceTimersByTimeAsync(11_000)
  expect(await submission(b.envelope.clientOperationId)).toBeUndefined()
  expect(store.getRecord(SESSION)?.instructionPolicy).toMatchObject({ state: 'delivered' })
})
