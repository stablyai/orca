import { describe, expect, it, vi } from 'vitest'
import { emptyOrcadActivationRecord } from '../../managed-server/activation/orcad-activation-record'
import { CURRENT_ORCAD_DAEMON_PROTOCOL } from '../../managed-server/activation/orcad-daemon-protocol-crossing'
import { planOrcadUpdate } from '../../managed-server/activation/orcad-update-plan'
import { readWslOrcadIncumbent, type WslOrcadIncumbentDependencies } from './wsl-orcad-incumbent'

const record = {
  ...emptyOrcadActivationRecord(),
  active: '0.1.0+old',
  activatedAt: '2026-11-01T00:00:00.000Z'
}

// The wake outcomes that leave the incumbent stopped and uncounted.
type Wake = { outcome: 'unverifiable' } | { outcome: 'fenced' }

async function incumbentAfterWake(wake: Wake) {
  const census = vi.fn<WslOrcadIncumbentDependencies['census']>()
  const dependencies: WslOrcadIncumbentDependencies = {
    wake: async () => wake,
    probe: vi.fn(),
    readBuildHash: vi.fn(),
    listen: vi.fn(),
    census
  }
  const incumbent = await readWslOrcadIncumbent(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a refused wake returns before any other context or slot field is read.
    { context: { activationRecord: record } as never, slot: {} as never },
    dependencies
  )
  expect(census).not.toHaveBeenCalled()
  return incumbent
}

// An incumbent Orca never started has no daemon to ask; blaming the daemon hid the real check (#51014).
describe('readWslOrcadIncumbent when the incumbent cannot be woken', () => {
  it.each([false, 'live-terminals', true] as const)(
    'names the inconclusive liveness check, not a silent daemon (force %s)',
    async (force) => {
      const incumbent = await incumbentAfterWake({ outcome: 'unverifiable' })
      expect(incumbent.readiness).toBeNull()
      expect(incumbent.census.liveSessions).toBeNull()
      const plan = planOrcadUpdate({
        record,
        candidateVersion: '0.1.0+new',
        census: incumbent.census,
        candidateDaemonProtocol: CURRENT_ORCAD_DAEMON_PROTOCOL,
        force
      })
      expect(plan).toMatchObject({
        action: 'defer',
        code:
          force === true
            ? 'orcad_update_daemon_protocol_unverifiable'
            : 'orcad_update_terminal_census_unavailable'
      })
      expect(plan).not.toHaveProperty('forceable')
      const reason = 'reason' in plan ? plan.reason : ''
      expect(reason).toContain('could not tell whether orcad 0.1.0+old is still running')
      expect(reason).not.toMatch(/terminal daemon did not (answer|report)/)
      expect((await incumbent.recount()).unansweredBecause).toBe(incumbent.census.unansweredBecause)
    }
  )

  it('names a held activation lock', async () => {
    const incumbent = await incumbentAfterWake({ outcome: 'fenced' })
    expect(incumbent.census.unansweredBecause).toContain('activation lock')
  })
})
