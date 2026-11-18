import type {
  ZotzNodeSetupProgress,
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
  /** Live state of several steps at once, for phases that settle them one by one. */
  publishSteps: (steps: readonly ZotzNodeSetupStep[]) => void
  /** Raw output lines (e.g. an elevated script's transcript) shown in the setup console. */
  appendOutput: (lines: readonly string[]) => void
}

/** One unit of work; a phase may settle several steps at once (one elevation covers many). */
export type ZotzNodeSetupPhase = {
  steps: readonly ZotzNodeSetupStepId[]
  /** The phase streams its own output, so the orchestrator writes no step lines for it. */
  ownsOutput?: boolean
  run: (
    context: ZotzNodeSetupPhaseContext
  ) => Promise<Partial<Record<ZotzNodeSetupStepId, ZotzNodeSetupOutcome>>>
}

const MAX_OUTPUT_LINES = 500

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Runs every phase in order; a failing phase never stops the ones after it. */
export async function runZotzNodeSetup(
  phases: readonly ZotzNodeSetupPhase[],
  onProgress: (progress: ZotzNodeSetupProgress) => void
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
  const output: string[] = []
  const appendOutput = (lines: readonly string[]): void => {
    output.push(...lines)
    if (output.length > MAX_OUTPUT_LINES) {
      output.splice(0, output.length - MAX_OUTPUT_LINES)
    }
  }
  const publish = (): void =>
    onProgress({ steps: steps.map((step) => ({ ...step })), output: [...output] })
  let currentPhase: ZotzNodeSetupPhase | null = null
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
      if (!currentPhase?.ownsOutput) {
        appendOutput([`${id}: ${detail}${url ? ` (${url})` : ''}`])
      }
      publish()
    },
    publishSteps: (next) => {
      for (const { id, ...patch } of next) {
        update(id, patch)
      }
      publish()
    },
    appendOutput: (lines) => {
      appendOutput(lines)
      publish()
    }
  }
  for (const phase of phases) {
    currentPhase = phase
    for (const id of phase.steps) {
      update(id, { status: 'running' })
    }
    if (!phase.ownsOutput) {
      appendOutput(phase.steps.map((id) => `== ${id} ==`))
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
      const outcome = outcomes[id] ?? { status: 'failed', detail: 'no result reported' }
      update(id, outcome)
      if (!phase.ownsOutput) {
        appendOutput([`${id} -> ${outcome.status}${outcome.detail ? `: ${outcome.detail}` : ''}`])
      }
    }
    publish()
  }
  return { steps, tailscaleIp }
}
