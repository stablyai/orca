import { describe, expect, it, vi } from 'vitest'
import {
  ORCAD_UPDATE_ADMISSION_FENCE_MS,
  type OrcadTerminalCensus
} from '../../shared/orcad-terminal-census'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { OrcadActivationRecord } from './orcad-activation-record'
import type { OrcadTerminalCensusRequestOptions } from './orcad-terminal-census-client'
import { sshUpdateAdmissionFence } from './orcad-update-admission-fence'

const idle: OrcadTerminalCensus = {
  liveSessions: 0,
  startedSinceActivation: 0,
  daemonProtocolVersion: 7
}
const unanswered: OrcadTerminalCensus = {
  liveSessions: null,
  startedSinceActivation: null,
  daemonProtocolVersion: null
}
// The fence never reads these; the injected count stands in for the server.
const environment = { id: 'env' } satisfies Pick<KnownRuntimeEnvironment, 'id'>
const record = { active: '1.0.0' } satisfies Partial<OrcadActivationRecord>

function fence(answers: OrcadTerminalCensus[]) {
  const count = vi.fn(async (_options: OrcadTerminalCensusRequestOptions) => answers.shift()!)
  const hooks = sshUpdateAdmissionFence(
    '/user-data',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only `count` reads them, and it is faked.
    environment as KnownRuntimeEnvironment,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    record as OrcadActivationRecord,
    idle,
    count
  )
  return { count, hooks }
}

describe('sshUpdateAdmissionFence (R32)', () => {
  it('closes admission for the update fence before the last count', async () => {
    const { count, hooks } = fence([{ ...idle, liveSessions: 1 }])
    await expect(hooks.recountCensus?.()).resolves.toMatchObject({ liveSessions: 1 })
    expect(count).toHaveBeenCalledWith({
      releaseFinishedAutomationTerminals: true,
      closeAdmissionForMs: ORCAD_UPDATE_ADMISSION_FENCE_MS
    })
  })

  it('keeps the pre-upload count when the recount goes unanswered, as SSH did before', async () => {
    const { hooks } = fence([unanswered])
    await expect(hooks.recountCensus?.()).resolves.toEqual(idle)
  })

  it('keeps a fenced server unverifiable when it could not settle its spawns', async () => {
    const { hooks } = fence([{ ...unanswered, admissionClosedUntil: 1 }])
    await expect(hooks.recountCensus?.()).resolves.toMatchObject({ liveSessions: null })
  })

  it('reopens admission with a 0 fence', async () => {
    const { count, hooks } = fence([idle])
    await hooks.releaseIncumbentAdmission?.()
    expect(count).toHaveBeenCalledWith({ closeAdmissionForMs: 0 })
  })
})
