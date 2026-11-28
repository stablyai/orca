import { describe, expect, it } from 'vitest'
import {
  CPU_SAMPLE_HISTORY_LIMIT,
  HOST_RESOURCES_POLL_INTERVAL_MS,
  appendCpuSampleHistory,
  hostResourcesPollDelayMs,
  hostResourcesRefusalStopsPolling,
  type HostResourcesPollGate
} from './host-resources-polling'

const open: HostResourcesPollGate = {
  focused: true,
  appActive: true,
  connected: true,
  capabilityPresent: true,
  unsupported: false
}

describe('host resource polling', () => {
  it('keeps the newest samples and drops the oldest past 36', () => {
    let history: readonly number[] = []
    for (let sample = 0; sample < CPU_SAMPLE_HISTORY_LIMIT + 4; sample += 1) {
      history = appendCpuSampleHistory(history, sample)
    }
    expect(history).toHaveLength(CPU_SAMPLE_HISTORY_LIMIT)
    expect(history[0]).toBe(4)
    expect(history.at(-1)).toBe(CPU_SAMPLE_HISTORY_LIMIT + 3)
    expect(appendCpuSampleHistory(history, null)).toBe(history)
  })

  it('does not schedule another poll while the screen is hidden', () => {
    expect(hostResourcesPollDelayMs({ ...open, focused: false })).toBeNull()
    expect(hostResourcesPollDelayMs({ ...open, appActive: false })).toBeNull()
    expect(hostResourcesPollDelayMs({ ...open, unsupported: true })).toBeNull()
    expect(hostResourcesPollDelayMs(open)).toBe(HOST_RESOURCES_POLL_INTERVAL_MS)
  })

  it('treats a missing method on an older server as a reason to stop', () => {
    expect(hostResourcesRefusalStopsPolling('forbidden')).toBe(true)
    expect(hostResourcesRefusalStopsPolling('method_not_found')).toBe(true)
    expect(hostResourcesRefusalStopsPolling('internal_error')).toBe(false)
  })
})
