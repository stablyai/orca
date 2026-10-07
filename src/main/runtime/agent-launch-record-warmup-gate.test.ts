import { describe, expect, it, vi } from 'vitest'
import { createAgentLaunchRecordWarmupGate } from './agent-launch-record-warmup-gate'

function gate(isOpen = false) {
  const open = vi.fn(async () => {})
  return { open, gate: createAgentLaunchRecordWarmupGate({ isOpen: () => isOpen, open }) }
}

describe('opening the launch record ahead of a launch', () => {
  it('waits for both startup to settle and a client that can launch', () => {
    const { open, gate: warmup } = gate()
    warmup.startupSettled()
    expect(open).not.toHaveBeenCalled()
    warmup.launchClientReady()
    expect(open).toHaveBeenCalledOnce()
  })

  it('never opens it during startup, even when a phone connects first', () => {
    const { open, gate: warmup } = gate()
    warmup.launchClientReady()
    expect(open).not.toHaveBeenCalled()
    warmup.startupSettled()
    expect(open).toHaveBeenCalledOnce()
  })

  it('never opens it for a profile no launching client uses', () => {
    const { open, gate: warmup } = gate()
    warmup.startupSettled()
    expect(open).not.toHaveBeenCalled()
  })

  it('does nothing when it is already open', () => {
    const { open, gate: warmup } = gate(true)
    warmup.startupSettled()
    warmup.launchClientReady()
    expect(open).not.toHaveBeenCalled()
  })
})
