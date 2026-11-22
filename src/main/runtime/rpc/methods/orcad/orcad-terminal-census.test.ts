import { expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../../core'
import { ORCAD_TERMINAL_CENSUS_METHODS } from './orcad-terminal-census'

it('reports no in-process count while an admitted spawn is still starting', async () => {
  const [method] = eraseRpcMethods(ORCAD_TERMINAL_CENSUS_METHODS)
  if (!method || isStreamingMethod(method)) {
    throw new Error('Missing census method')
  }
  const terminalUpdateAdmission = {
    close: vi.fn(() => 60_000),
    waitForSpawnsToSettle: vi.fn(async () => false)
  }
  const context: RpcContext = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this branch reads only the admission fence stubbed here.
    runtime: { terminalUpdateAdmission } as unknown as OrcaRuntimeService,
    clientKind: 'runtime',
    pairedDeviceId: 'paired-desktop'
  }
  await expect(
    method.handler(method.params?.parse({ activatedAt: 0, closeAdmissionForMs: 60_000 }), context)
  ).resolves.toStrictEqual({
    liveSessions: null,
    startedSinceActivation: null,
    daemonProtocolVersion: null,
    inProcessSessions: null,
    admissionClosedUntil: 60_000
  })
})
