import { describe, expect, it } from 'vitest'
import {
  hasQuietMuseReadyPrompt,
  isTuiIdleSatisfied,
  type TuiIdleEvidenceRecord,
  type TuiIdleSatisfactionInput
} from './tui-idle-evidence'

const QUIESCENCE_MS = 3000

function record(overrides: Partial<TuiIdleEvidenceRecord> = {}): TuiIdleEvidenceRecord {
  return {
    lastAgentStatus: null,
    lastOutputAt: Date.now() - QUIESCENCE_MS * 2,
    lastOscTitle: 'tmp',
    ...overrides
  }
}

function input(overrides: Partial<TuiIdleSatisfactionInput> = {}): TuiIdleSatisfactionInput {
  return {
    record: record(),
    readPositiveBodyEvidence: () => false,
    readMuseReadyBodyEvidence: () => true,
    agent: 'muse',
    firstPartyStatus: null,
    quiescenceMs: QUIESCENCE_MS,
    ...overrides
  }
}

describe('hasQuietMuseReadyPrompt', () => {
  it('settles a Muse ready screen once the stream has gone quiet', () => {
    expect(hasQuietMuseReadyPrompt(record(), 'muse', () => true, QUIESCENCE_MS)).toBe(true)
  })

  it('refuses while the pane is still streaming', () => {
    expect(
      hasQuietMuseReadyPrompt(
        record({ lastOutputAt: Date.now() }),
        'muse',
        () => true,
        QUIESCENCE_MS
      )
    ).toBe(false)
  })

  it('refuses without an output clock, like the tier-3 lane', () => {
    expect(
      hasQuietMuseReadyPrompt(record({ lastOutputAt: null }), 'muse', () => true, QUIESCENCE_MS)
    ).toBe(false)
  })

  it('refuses without a ready screen', () => {
    expect(hasQuietMuseReadyPrompt(record(), 'muse', () => false, QUIESCENCE_MS)).toBe(false)
  })

  it('covers adopted panes that carry no launch metadata', () => {
    expect(hasQuietMuseReadyPrompt(record(), null, () => true, QUIESCENCE_MS)).toBe(true)
    expect(hasQuietMuseReadyPrompt(record(), undefined, () => true, QUIESCENCE_MS)).toBe(true)
  })

  it('refuses another agent quoting Muse in its scrollback', () => {
    expect(hasQuietMuseReadyPrompt(record(), 'codex', () => true, QUIESCENCE_MS)).toBe(false)
  })
})

describe('isTuiIdleSatisfied deepseek build lane', () => {
  const ready = () => true
  const workingTitle = '⠼ - Waiting for response… - DeepSeek Build'

  it('settles a resting composer', () => {
    expect(
      isTuiIdleSatisfied(
        input({
          agent: 'dsb',
          record: record({ lastOscTitle: 'DeepSeek Build' }),
          readDsbReadyBodyEvidence: ready,
          readMuseReadyBodyEvidence: () => false
        })
      )
    ).toBe(true)
  })

  it('does not treat a shared ready hit as a DeepSeek Build composer', () => {
    expect(
      isTuiIdleSatisfied(
        input({
          agent: 'dsb',
          record: record({ lastOscTitle: 'DeepSeek Build' }),
          readPositiveBodyEvidence: ready,
          readMuseReadyBodyEvidence: () => false
        })
      )
    ).toBe(false)
  })

  it('vetoes when either title is still working, including a fresh done status', () => {
    expect(
      isTuiIdleSatisfied(
        input({
          agent: 'dsb',
          rendererTitle: 'DeepSeek Build',
          record: record({ lastOscTitle: workingTitle }),
          readDsbReadyBodyEvidence: ready,
          firstPartyStatus: { state: 'done', updatedAt: Date.now() }
        })
      )
    ).toBe(false)
    expect(
      isTuiIdleSatisfied(
        input({
          agent: 'dsb',
          rendererTitle: workingTitle,
          record: record({ lastOscTitle: 'DeepSeek Build' }),
          readDsbReadyBodyEvidence: ready,
          firstPartyStatus: { state: 'done', updatedAt: Date.now() }
        })
      )
    ).toBe(false)
  })

  it('lets a done newer than the OSC title settle a lagging working title', () => {
    expect(
      isTuiIdleSatisfied(
        input({
          agent: 'dsb',
          record: record({ lastOscTitle: workingTitle, lastOscTitleEpochMs: 1_000 }),
          readDsbReadyBodyEvidence: ready,
          firstPartyStatus: { state: 'done', updatedAt: 2_000 }
        })
      )
    ).toBe(true)
  })

  it('keeps a working renderer title in front of an older OSC clock', () => {
    expect(
      isTuiIdleSatisfied(
        input({
          agent: 'dsb',
          rendererTitle: workingTitle,
          record: record({ lastOscTitle: workingTitle, lastOscTitleEpochMs: 1_000 }),
          readDsbReadyBodyEvidence: ready,
          firstPartyStatus: { state: 'done', updatedAt: 2_000 }
        })
      )
    ).toBe(false)
  })

  it('keeps the veto when the working title is newer than done', () => {
    expect(
      isTuiIdleSatisfied(
        input({
          agent: 'dsb',
          record: record({ lastOscTitle: workingTitle, lastOscTitleEpochMs: 3_000 }),
          readDsbReadyBodyEvidence: ready,
          firstPartyStatus: { state: 'done', updatedAt: 2_000 }
        })
      )
    ).toBe(false)
  })

  it('does not let an empty renderer title hide a working OSC title', () => {
    expect(
      isTuiIdleSatisfied(
        input({
          agent: 'dsb',
          rendererTitle: '',
          record: record({ lastOscTitle: workingTitle }),
          readDsbReadyBodyEvidence: ready
        })
      )
    ).toBe(false)
  })
})

describe('isTuiIdleSatisfied muse lane', () => {
  it('settles a quiet Muse pane with no title signal at all', () => {
    expect(isTuiIdleSatisfied(input())).toBe(true)
  })

  it('lets a fresh first-party working status veto the Muse body', () => {
    expect(
      isTuiIdleSatisfied(input({ firstPartyStatus: { state: 'working', updatedAt: Date.now() } }))
    ).toBe(false)
  })
})
