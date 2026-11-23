import { expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { SleepingMailRecordIndex } from './sleeping-mail-record-index'

const NONE: Readonly<Record<string, SleepingAgentSessionRecord>> = Object.freeze({})

it.each([100, 1_000])('retains no input of %i hosts added then removed', (count) => {
  const index = new SleepingMailRecordIndex()
  const live = ['local']
  index.refresh('local', {}, () => {})
  for (let host = 0; host < count; host++) {
    const id = `ssh-target-${host}`
    // A session write for the added host, then one after its removal, as the runtime's listener sees them.
    index.refresh(id, {}, () => {})
    index.forgetUnlessLive(id, [...live, id])
    index.refresh(id, NONE, () => {})
    index.forgetUnlessLive(id, live)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the per-host input cache is the retention under test.
  const cached = (index as unknown as { inputs: ReadonlyMap<string, unknown> }).inputs
  expect([...cached.keys()]).toEqual(['local'])
})
