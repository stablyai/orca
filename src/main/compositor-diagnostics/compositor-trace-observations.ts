export type CompositorTraceObservation = {
  pid: number
  classification: 'observations-only' | 'proxy-progress-observed'
  surfaceIdentity: null
  renderPassAttempts: number
  calculationSuccesses: number
  calculationAborts: number
  calculationUnknown: number
  emptyDamage: number
  exactFrameProxyEvents: number
  frameProxyBegins: number
  frameProxyEnds: number
  compositorThreadCoverage: 'unidentified' | 'identified'
  finishImplFrameSlices: number | null
  finishImplFrameWallMs: number | null
  finishImplFrameThreadMs: number | null
  submissions: null
  presentations: null
  sorterProgress: null
  trackerCoverage: 'unknown'
}

export type CompositorTraceResult =
  | { ok: true; observations: CompositorTraceObservation[]; cpuMicros: number }
  | { ok: false; reason: 'trace-invalid' | 'parser-budget' | 'parser-unavailable' }

export type CompositorParserRequest = { id: number; chunk?: Uint8Array; end?: boolean }
export type CompositorParserResponse = { id: number } & ({ ready: true } | CompositorTraceResult)

export function emptyCompositorObservation(pid: number): CompositorTraceObservation {
  return {
    pid,
    classification: 'observations-only',
    surfaceIdentity: null,
    renderPassAttempts: 0,
    calculationSuccesses: 0,
    calculationAborts: 0,
    calculationUnknown: 0,
    emptyDamage: 0,
    exactFrameProxyEvents: 0,
    frameProxyBegins: 0,
    frameProxyEnds: 0,
    compositorThreadCoverage: 'unidentified',
    finishImplFrameSlices: null,
    finishImplFrameWallMs: null,
    finishImplFrameThreadMs: null,
    submissions: null,
    presentations: null,
    sorterProgress: null,
    trackerCoverage: 'unknown'
  }
}
