import { describe, expect, it } from 'vitest'
import type { UsageWindowEntry } from '../composer-usage/agent-usage-provider'
import { pickRailUsageWindow } from './rail-usage-model'

const entry = (kind: UsageWindowEntry['kind'], usedPercent: number): UsageWindowEntry => ({
  id: kind,
  kind,
  name: null,
  window: {
    usedPercent,
    windowMinutes: kind === 'weekly' ? 10080 : 300,
    resetsAt: null,
    resetDescription: null
  }
})

describe('pickRailUsageWindow', () => {
  const windows = [entry('session', 20), entry('weekly', 80)]

  it('follows the composer 5-hour / weekly choice, and falls back when that window is missing', () => {
    expect(pickRailUsageWindow(windows, 'session')?.kind).toBe('session')
    expect(pickRailUsageWindow(windows, 'weekly')?.kind).toBe('weekly')
    expect(pickRailUsageWindow(windows)?.kind).toBe('session')
    expect(pickRailUsageWindow([entry('weekly', 80)], 'session')?.kind).toBe('weekly')
  })
})
