import { describe, expect, it } from 'vitest'
import { extractAllOscTitles } from '../../shared/osc-title-extraction'
import { readRuntimeFixture } from './agent-transcript-replay-test-harness'

describe('Kiro titles from captured terminal bytes', () => {
  it('sets OSC titles only before its first paint, never through a turn', () => {
    const data = readRuntimeFixture('kiro-2-27-1-v3-turn')
    const firstPaint = data.indexOf('Welcome to')
    const working = data.indexOf('Kiro is working')
    const idle = data.lastIndexOf('ask a question or describe a task')
    expect(firstPaint).toBeGreaterThan(-1)
    expect(working).toBeGreaterThan(firstPaint)
    expect(idle).toBeGreaterThan(working)
    expect(extractAllOscTitles(data.slice(0, firstPaint))).toContain('kiro')
    // Why: this absence is why Kiro gets Orca's synthetic hook titles (synthetic-agent-title.ts).
    expect(extractAllOscTitles(data.slice(firstPaint))).toEqual([])
  })
})
