import { expect, it } from 'vitest'
import { REST_TEST_CALLER } from './structured-agent-session-rest-test-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data.test-fixture'
import { readTestHostJournal } from '../../../agent-session-journal/journal-observation.test-support'
import {
  adoptedHistoryChat as adoptedChat,
  historyTurn as turn
} from './structured-agent-session-history-refresh.test-fixture'

it('returns local history before a blocked external read', async () => {
  const { rig, source, append } = await adoptedChat()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let reveal: Promise<unknown> | undefined
  try {
    await append(1)
    source.beforeFullRead = async () => {
      entered.resolve()
      await release.promise
    }
    reveal = rig.host.revealSession(SESSION)
    expect(
      await Promise.race([
        reveal.then(() => 'revealed'),
        entered.promise.then(() => 'external-read')
      ])
    ).toBe('revealed')
  } finally {
    release.resolve()
    await reveal
    await rig.dispose()
  }
})

it.each(['operations', 'bytes', 'failure'] as const)(
  'reports %s without partial imports or repeated notices',
  async (budget) => {
    const { rig, source, prompts, refresh } = await adoptedChat()
    try {
      if (budget === 'operations') {
        source.turns = Array.from({ length: 600 }, (_, n) => turn(n))
      } else if (budget === 'bytes') {
        source.turns = [
          turn(0),
          ...Array.from({ length: 100 }, (_, n) => turn(n + 1, 'x'.repeat(200_000)))
        ]
      } else {
        source.turns.push(turn(1))
        source.beforeFullRead = async () => {
          throw new Error('synthetic transport failure')
        }
      }
      await refresh()
      expect(await prompts()).toEqual(['synthetic prompt 0'])
      const rows = (await readTestHostJournal(rig.host, SESSION)).items
      expect(rows.flatMap((row) => (row.body.kind === 'status' ? [row.body.text] : []))).toEqual([
        budget === 'failure'
          ? 'External history was not refreshed: the history read failed. Local history is unchanged.'
          : 'External history was not refreshed: it exceeds the safe import limit. Local history is unchanged.'
      ])
      const { journal } = await rig.host.conversation(SESSION)
      const cursor = journal.physicalCursor()
      await refresh()
      expect(journal.physicalCursor()).toEqual(cursor)
      expect(await prompts()).toEqual(['synthetic prompt 0'])
    } finally {
      await rig.dispose()
    }
  }
)

it('catches up an adopted journal on reveal and restart without taking ownership or duplicating pages', async () => {
  const { rig, append, prompts } = await adoptedChat()
  try {
    expect(await prompts()).toEqual(['synthetic prompt 0'])
    await append(1)
    await append(2)
    const lease = rig.store.getRecord(SESSION)!.lease
    await rig.host.revealSession(SESSION)
    await rig.host.collaboratorsForTests().tasks.drainAttaches()
    expect(await prompts()).toEqual([
      'synthetic prompt 0',
      'synthetic prompt 1',
      'synthetic prompt 2'
    ])
    await rig.host.revealSession(SESSION)
    await rig.host.collaboratorsForTests().tasks.drainAttaches()
    expect(await prompts()).toEqual([
      'synthetic prompt 0',
      'synthetic prompt 1',
      'synthetic prompt 2'
    ])
    await append(3)
    await rig.restart({ adapter: rig.host.deps.adapter })
    await rig.host.revealSession(SESSION)
    await rig.host.collaboratorsForTests().tasks.drainAttaches()
    expect(await prompts()).toEqual([
      'synthetic prompt 0',
      'synthetic prompt 1',
      'synthetic prompt 2',
      'synthetic prompt 3'
    ])
    expect(rig.store.getRecord(SESSION)!.lease).toEqual(lease)
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
    expect(rig.adapter.dispatch).not.toHaveBeenCalled()
  } finally {
    await rig.dispose()
  }
})

it.each(['pending', 'cursor', 'fence'] as const)(
  'preserves local data when %s prevents refresh',
  async (reason) => {
    const { rig, append, prompts, source } = await adoptedChat()
    try {
      await append(1)
      const { journal } = await rig.host.conversation(SESSION)
      if (reason === 'pending') {
        await journal.write({
          kind: 'submission',
          input: {
            clientMessageId: 'pending-local',
            payloadFingerprint: 'pending-local',
            body: hostTestMessage('local pending'),
            fence: 1
          }
        })
      } else {
        source.beforeFullRead = async () => {
          source.beforeFullRead = async () => {}
          if (reason === 'cursor') {
            await journal.appendItem(
              { provider: 'orca', clientMessageId: 'local-note' },
              hostTestMessage('local note'),
              { fence: 1, turnScope: { kind: 'thread' } }
            )
          } else {
            const previous = rig.store.getRecord(SESSION)!
            await rig.store.reserveOwner({
              sessionId: SESSION,
              location: previous.location,
              provider: previous.provider,
              accountHome: previous.accountHome,
              expectedFence: 1,
              claimKeyId: 'key-1',
              handoffOperationId: null,
              probe: { outcome: 'indeterminate', reason: 'fixture' },
              spawnToken: 'external-owner',
              operation: {
                callerKey: REST_TEST_CALLER.callerKey,
                operationId: hostTestOperationId(),
                fingerprint: 'external-owner'
              },
              now: rig.clock.now
            })
          }
        }
      }
      await rig.host.revealSession(SESSION)
      await rig.host.collaboratorsForTests().tasks.drainAttaches()
      expect(await prompts()).toEqual(
        reason === 'cursor'
          ? ['synthetic prompt 0', 'local note']
          : reason === 'pending'
            ? ['synthetic prompt 0', 'local pending']
            : ['synthetic prompt 0']
      )
      if (reason === 'pending') {
        expect(
          (await journal.reads.input({ kind: 'unsettled-submissions' })).submissions.map(
            (row) => row.clientMessageId
          )
        ).toEqual(['pending-local'])
      }
      if (reason === 'fence') {
        const reserved = rig.store.getRecord(SESSION)!.lease
        expect(reserved).toMatchObject({
          runtimeFence: 2,
          claimStatus: 'reserved',
          reservedSpawnToken: 'external-owner'
        })
        await rig.host.revealSession(SESSION)
        await rig.host.collaboratorsForTests().tasks.drainAttaches()
        expect(rig.store.getRecord(SESSION)!.lease).toEqual(reserved)
        expect(await prompts()).toEqual(['synthetic prompt 0'])
      }
      expect(rig.adapter.acquire).not.toHaveBeenCalled()
      expect(rig.adapter.dispatch).not.toHaveBeenCalled()
    } finally {
      await rig.dispose()
    }
  }
)
