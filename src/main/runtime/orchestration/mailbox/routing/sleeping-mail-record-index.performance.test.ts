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

it.each([100, 1_000])(
  'one workspace reads only its own of %i sleep records, and a removed record leaves no bucket',
  (count) => {
    const index = new SleepingMailRecordIndex()
    const records: Record<string, SleepingAgentSessionRecord> = {}
    for (let entry = 0; entry < count; entry++) {
      const paneKey = `tab:${String(entry).padStart(8, '0')}-1111-4111-8111-111111111111`
      records[paneKey] = {
        paneKey,
        worktreeId: `wt-${entry}`,
        agent: 'claude',
        origin: 'worktree-sleep',
        state: 'done',
        prompt: '',
        providerSession: { key: 'session_id', id: `slept-${entry}` },
        capturedAt: 1,
        updatedAt: 1
      }
    }
    index.refresh('local', records, () => {})
    expect([...index.panesIn('wt-0')]).toHaveLength(1)
    index.refresh('local', NONE, () => {})
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the per-workspace bucket is the retention under test.
    const buckets = (index as unknown as { panesByWorktree: ReadonlyMap<string, unknown> })
      .panesByWorktree
    expect(buckets.size).toBe(0)
  }
)

it.each([100, 1_000])(
  'session writes that leave a host’s sleep records unchanged list none of %i saved hosts',
  (hosts) => {
    const index = new SleepingMailRecordIndex()
    const saved = Array.from({ length: hosts }, (_, host) => `ssh:target-${host}`)
    let listed = 0
    const live = () => {
      listed += saved.length
      return saved
    }
    index.sessionWritten(
      'local',
      live,
      () => NONE,
      () => {}
    )
    listed = 0
    for (let write = 0; write < 10; write++) {
      index.sessionWritten(
        'local',
        live,
        () => NONE,
        () => {}
      )
    }
    expect(listed).toBe(0)
  }
)
