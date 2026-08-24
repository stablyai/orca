import { describe, expect, it } from 'vitest'
import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'
import {
  appendNormalizedToTailBuffer,
  computeTerminalTailWaitState,
  type TerminalTailWaitState
} from './orca-runtime'

// Mirrors the leaf branch of onPtyData's tail refresh (#15597): the pane's
// published waitBlockedReason is the CURRENT actionable signal of the retained
// tail — stamped on gain, cleared on dismissal — and transitions only when the
// reason actually changes, which is what gates the client-event emission.

type LeafSim = {
  tailBuffer: string[]
  tailPartialLine: string
  preview: string
  waitBlockedReason: RuntimeTerminalWaitBlockedReason | null
  tailWaitState?: TerminalTailWaitState
}

function newLeafSim(): LeafSim {
  return { tailBuffer: [], tailPartialLine: '', preview: '', waitBlockedReason: null }
}

function stepLeaf(sim: LeafSim, chunk: string): RuntimeTerminalWaitBlockedReason | null {
  const nextTail = appendNormalizedToTailBuffer(sim.tailBuffer, sim.tailPartialLine, chunk, null)
  const nextWaitState = computeTerminalTailWaitState(
    nextTail.lines,
    nextTail.partialLine,
    sim.preview
  )
  sim.tailBuffer = nextTail.lines
  sim.tailPartialLine = nextTail.partialLine
  sim.tailWaitState = nextWaitState
  sim.waitBlockedReason = nextWaitState.signal?.reason ?? null
  return sim.waitBlockedReason
}

describe('leaf waitBlockedReason transitions', () => {
  it('stays null through ordinary output', () => {
    const sim = newLeafSim()
    expect(stepLeaf(sim, 'building…\ndone\n')).toBeNull()
    expect(sim.waitBlockedReason).toBeNull()
  })

  it('gains the update-prompt reason when the dialog appears', () => {
    const sim = newLeafSim()
    stepLeaf(sim, 'Update available 1.0.0 -> 1.1.0\nPress Enter to continue\n')
    expect(sim.waitBlockedReason).toBe('codex-update-prompt')
  })

  it('clears once a ready prompt proves the dialog was dismissed', () => {
    const sim = newLeafSim()
    stepLeaf(sim, 'Update available 1.0.0 -> 1.1.0\nPress Enter to continue\n')
    expect(sim.waitBlockedReason).toBe('codex-update-prompt')
    // The dismissed-modal logic treats a later ready prompt as proof the dialog
    // was answered, so the published reason must return to null. The ready
    // header Codex actually prints is "OpenAI Codex" + model + directory.
    expect(stepLeaf(sim, '\nOpenAI Codex\nmodel: gpt-5\ndirectory: /repo\n')).toBeNull()
  })

  it('reports the trust prompt for a vendor-neutral shape', () => {
    const sim = newLeafSim()
    stepLeaf(sim, 'Do you trust the files in this folder?\n')
    expect(sim.waitBlockedReason).toBe('codex-trust-workspace')
  })
})
