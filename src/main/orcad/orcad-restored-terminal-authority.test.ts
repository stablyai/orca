import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcadFeatureReadiness } from '../runtime/rpc/orcad-feature-readiness'

const steps = vi.hoisted(() => new Array<string>())
vi.mock('../runtime/terminal/adoption/unshown-live-terminal-placement', () => ({
  placeUnshownLiveTerminalsBestEffort: async () => {
    steps.push('placement')
  }
}))
vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

import { restoreOrcadTerminalAuthority } from './orcad-restored-terminal-authority'

describe('restoreOrcadTerminalAuthority', () => {
  it('opens each latch only once its phase is done, with reconcile ungated in between', async () => {
    const readiness = new OrcadFeatureReadiness(['orchestration', 'unshownPlacement'])
    const latches = (): string =>
      `orchestration=${readiness.isOpen('orchestration')} placement=${readiness.isOpen('unshownPlacement')}`
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the two restore phases are called.
    const runtime = {
      refreshRestoredOrchestrationAuthority: async () => {
        steps.push(`orchestration ${latches()}`)
      },
      reconcileLegacyWorkerTerminals: async () => {
        steps.push(`reconcile ${latches()}`)
      }
    } as unknown as OrcaRuntimeService

    await restoreOrcadTerminalAuthority(runtime, (_name, run) => run(), readiness)

    expect(steps).toEqual([
      'orchestration orchestration=false placement=false',
      'reconcile orchestration=true placement=false',
      'placement'
    ])
    expect(readiness.isOpen('unshownPlacement')).toBe(true)
  })
})
