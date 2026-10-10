// A Grok crash mid-reply, through the real host: the host's settlement of the proven exit writes one
// `provider-exit:` batch whose cut-short row reports on the turn the crash ended, carrying the
// adapter's failure with Grok's last words. Whether Grok's pipes closed before its exit was seen
// changes only what the chat shows in between.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAgentSessionFailureFact } from '../../shared/agent-session-failure'
import { journalLifecycleMutationItemId } from '../native-chat/agent-session-journal/journal-row-builders'
import { PROVIDER_EXIT_ROW_PREFIX } from '../../shared/agent-session-stop-row-identity'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import type { JournalLifecycleBatchInput } from '../native-chat/agent-session-journal/journal-store-contracts'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { replyChunk, shellCall, waitFor } from './acp-structured-adapter.test-support'
import { openAttachedHostRig, promptIdOf, send } from './acp-structured-host.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const LAST_WORDS = 'qa-cell20-last-words'

/** Grok mid-reply ("Oak") with a command running, every lifecycle batch the journal takes recorded. */
async function midReply() {
  const rig = await openAttachedHostRig()
  const { host } = rig
  await send(host, 'hello')
  const prompt = await rig.rig.frame('session/prompt')
  const child = rig.rig.child()
  child.agent.notify('session/update', replyChunk(promptIdOf(prompt), 'Oak'))
  child.agent.notify('session/update', shellCall(promptIdOf(prompt), 'in_progress'))
  await rig.rig.settle()
  await host.flushStreamedEvents(SESSION)
  const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const batches: JournalLifecycleBatchInput[] = []
  const append = journal.appendLifecycleBatch.bind(journal)
  vi.spyOn(journal, 'appendLifecycleBatch').mockImplementation((batch) => {
    batches.push(batch)
    return append(batch)
  })
  child.stderr = LAST_WORDS
  return { ...rig, child, batches }
}

async function settledCrash(rig: Awaited<ReturnType<typeof midReply>>) {
  const providerExits = () =>
    rig.batches.filter((batch) =>
      batch.settlementId.startsWith(`dead-generation:${PROVIDER_EXIT_ROW_PREFIX}`)
    )
  await waitFor(() => expect(providerExits()).toHaveLength(1))
  const rows = await rig.rows()
  const turn = rows.find((row) => readAgentJournalTurn(row.body) !== null)
  const statuses = rows.filter((row) => row.body.kind === 'status')
  return { batch: providerExits()[0]!, rows, turn, statuses }
}

function expectOneTurnScopedCutShortRow(settled: Awaited<ReturnType<typeof settledCrash>>) {
  const { turn, statuses, rows } = settled
  expect(readAgentJournalTurn(turn?.body)).toMatchObject({ state: 'interrupted' })
  expect(statuses).toHaveLength(1)
  const [row] = statuses
  expect(decodeURIComponent(row?.itemId ?? '')).toContain(PROVIDER_EXIT_ROW_PREFIX)
  expect(row?.turnScope).toEqual({ kind: 'turn', turnItemId: turn?.itemId })
  expect(
    readAgentSessionFailureFact(row?.body.kind === 'status' ? row.body.failure : undefined)
  ).toEqual({ kind: 'providerExited', detail: { text: LAST_WORDS, audience: 'person' } })
  expect(rows.find((item) => item.body.kind === 'tool-call')?.body).toMatchObject({
    state: 'failed',
    endedAs: 'interrupted'
  })
}

describe('a Grok crash with its exit seen first', () => {
  it('ends the turn at the exit itself; the provider-exit batch only reports on it', async () => {
    const rig = await midReply()
    rig.child.exit()
    const settled = await settledCrash(rig)
    expectOneTurnScopedCutShortRow(settled)
    // The child's own end landed first, interrupted at the exit and never `unverifiable`: the host
    // has no turn or call of it left to revise.
    expect(
      settled.batch.mutations.map((mutation) => mutation.kind === 'item' && mutation.body.kind)
    ).toEqual(['status'])
    await rig.host.close(SESSION, 'user-close')
  })
})

describe('a Grok crash whose pipes close before its exit is seen', () => {
  it('is unverifiable only until the exit is proven; the provider-exit batch then revises the turn', async () => {
    const rig = await midReply()
    // The child outlives its stream until Orca's close of it is proven.
    let exitNow: () => void = () => undefined
    rig.child.proveClose = () =>
      new Promise((resolve) => {
        exitNow = () => {
          rig.child.exit()
          resolve(true)
        }
      })
    rig.child.agent.close()
    await waitFor(async () =>
      expect((await rig.turns()).map((turn) => turn.state)).toEqual(['unverifiable'])
    )
    expect((await rig.rows()).filter((row) => row.body.kind === 'status')).toEqual([])

    exitNow()
    const settled = await settledCrash(rig)
    expectOneTurnScopedCutShortRow(settled)
    // The turn's revision, its call's and the row land together.
    const turnKey = settled.turn!.itemId
    expect(
      settled.batch.mutations.flatMap((mutation) =>
        mutation.kind === 'item' ? [journalLifecycleMutationItemId(mutation)] : []
      )
    ).toEqual(expect.arrayContaining([settled.statuses[0]!.itemId, turnKey]))
    // No later stale-session pass rewrites it: nothing is left for one.
    expect(rig.batches.filter((batch) => batch.settlementId.includes('stale-session'))).toEqual([])
    await rig.host.close(SESSION, 'user-close')
  })
})
