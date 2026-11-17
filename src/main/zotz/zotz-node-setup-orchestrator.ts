import type {
  ZotzNodeSetupResult,
  ZotzNodeSetupStep,
  ZotzNodeSetupStepId,
  ZotzNodeSetupStepStatus
} from '../../shared/zotz/zotz-node-setup-contract'

export type ZotzNodeSetupOutcome = {
  status: 'done' | 'skipped' | 'failed'
  detail?: string
  url?: string
}

export type ZotzNodeSetupPhaseContext = {
  tailscaleIp: string | null
  setTailscaleIp: (ip: string | null) => void
  stepStatus: (id: ZotzNodeSetupStepId) => ZotzNodeSetupStepStatus | undefined
  /** Live detail for a running step, e.g. "waiting for login" with the login page. */
  report: (id: ZotzNodeSetupStepId, detail: string, url?: string) => void
}

/** One unit of work; a phase may settle several steps at once (one elevation covers many). */
export type ZotzNodeSetupPhase = {
  steps: readonly ZotzNodeSetupStepId[]
  run: (
    context: ZotzNodeSetupPhaseContext
  ) => Promise<Partial<Record<ZotzNodeSetupStepId, ZotzNodeSetupOutcome>>>
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Runs every phase in order; a failing phase never stops the ones after it. */
export async function runZotzNodeSetup(
  phases: readonly ZotzNodeSetupPhase[],
  onProgress: (steps: ZotzNodeSetupStep[]) => void
): Promise<ZotzNodeSetupResult> {
  const steps: ZotzNodeSetupStep[] = phases.flatMap((phase) =>
    phase.steps.map((id): ZotzNodeSetupStep => ({ id, status: 'pending' }))
  )
  const update = (id: ZotzNodeSetupStepId, patch: Omit<ZotzNodeSetupStep, 'id'>): void => {
    const index = steps.findIndex((step) => step.id === id)
    if (index !== -1) {
      steps[index] = { id, ...patch }
    }
  }
  const publish = (): void => onProgress(steps.map((step) => ({ ...step })))
  let tailscaleIp: string | null = null
  const context: ZotzNodeSetupPhaseContext = {
    get tailscaleIp() {
      return tailscaleIp
    },
    setTailscaleIp: (ip) => {
      tailscaleIp = ip
    },
    stepStatus: (id) => steps.find((step) => step.id === id)?.status,
    report: (id, detail, url) => {
      update(id, { status: 'running', detail, ...(url ? { url } : {}) })
      publish()
    }
  }
  for (const phase of phases) {
    for (const id of phase.steps) {
      update(id, { status: 'running' })
    }
    publish()
    let outcomes: Partial<Record<ZotzNodeSetupStepId, ZotzNodeSetupOutcome>>
    try {
      outcomes = await phase.run(context)
    } catch (error) {
      const detail = errorDetail(error)
      outcomes = Object.fromEntries(phase.steps.map((id) => [id, { status: 'failed', detail }]))
    }
    for (const id of phase.steps) {
      update(id, outcomes[id] ?? { status: 'failed', detail: 'no result reported' })
    }
    publish()
  }
  return { steps, tailscaleIp }
}
