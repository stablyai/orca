import { beforeEach, describe, expect, it, vi } from 'vitest'

const track = vi.hoisted(() => vi.fn())
vi.mock('../../../telemetry/client', () => ({ track }))
vi.mock('../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const { recordPtySpawnErrorTelemetry } = await import('./spawn-telemetry')

beforeEach(() => {
  track.mockClear()
})

// Why: the host's spawn pipeline records a failed agent launch exactly as the window's does.
describe('a failed agent spawn', () => {
  it('is recorded under the launch agent', () => {
    recordPtySpawnErrorTelemetry({ agent_kind: 'codex' }, new Error('spawn failed'), false)

    expect(track).toHaveBeenCalledExactlyOnceWith(
      'agent_error',
      expect.objectContaining({ agent_kind: 'codex', error_class: expect.any(String) })
    )
  })

  it('falls back to a sniffed Claude launch, and records nothing for a plain terminal', () => {
    recordPtySpawnErrorTelemetry(undefined, new Error('spawn failed'), true)
    recordPtySpawnErrorTelemetry(undefined, new Error('spawn failed'), false)

    expect(track).toHaveBeenCalledExactlyOnceWith(
      'agent_error',
      expect.objectContaining({ agent_kind: 'claude-code' })
    )
  })
})
