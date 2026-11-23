import { expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { SleepingMailRecordIndex } from './sleeping-mail-record-index'

const PANE = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222'

it('treats a sleeper on a host that was removed and came back as an arrival, so its owned mail is read', () => {
  const index = new SleepingMailRecordIndex()
  index.refresh('local', {}, () => {})
  index.refresh('ssh-target', {}, () => {})
  index.finishInitialRead()

  // The host is removed: its records go and its cached input is forgotten.
  index.refresh('ssh-target', {}, () => {})
  index.forgetUnlessLive('ssh-target', ['local'])
  // It is published again with an agent Agent Sleep stopped while the host was away.
  const record: SleepingAgentSessionRecord = {
    paneKey: PANE,
    worktreeId: 'wt',
    agent: 'claude',
    origin: 'worktree-sleep',
    state: 'done',
    prompt: '',
    providerSession: { key: 'session_id', id: 'slept' },
    capturedAt: 1,
    updatedAt: 1
  }
  index.refresh('ssh-target', { [PANE]: record }, () => {})

  expect(index.takeArrival(PANE)).toBe(true)
})
