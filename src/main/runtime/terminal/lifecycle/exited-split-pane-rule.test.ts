import { describe, expect, it } from 'vitest'
import { exitedSplitPaneOutcome, type ExitedSplitPaneFacts } from './exited-split-pane-rule'

const used: ExitedSplitPaneFacts = {
  exitCode: 0,
  freshSpawn: true,
  inputSeen: true,
  outputSeen: true,
  shown: true
}

describe('exitedSplitPaneOutcome', () => {
  it('closes a split pane whose shell exited cleanly', () => {
    expect(exitedSplitPaneOutcome(used)).toBe('close')
  })

  it('keeps a failed process behind its card', () => {
    expect(exitedSplitPaneOutcome({ ...used, exitCode: 1 })).toBe('keep')
  })

  it('keeps a pane on any negative code, as the window does: the code proves no death', () => {
    expect(exitedSplitPaneOutcome({ ...used, exitCode: -1 })).toBe('keep')
    expect(exitedSplitPaneOutcome({ ...used, exitCode: -1 }, true)).toBe('keep')
  })

  it('keeps a newborn split that died while shown before any input or output', () => {
    const newborn = { ...used, inputSeen: false, outputSeen: false }
    expect(exitedSplitPaneOutcome(newborn)).toBe('keep')
    expect(exitedSplitPaneOutcome({ ...newborn, shown: false })).toBe('close')
    expect(exitedSplitPaneOutcome({ ...newborn, freshSpawn: false })).toBe('close')
    expect(exitedSplitPaneOutcome({ ...newborn, inputSeen: true })).toBe('close')
    expect(exitedSplitPaneOutcome({ ...newborn, outputSeen: true })).toBe('close')
  })
})
