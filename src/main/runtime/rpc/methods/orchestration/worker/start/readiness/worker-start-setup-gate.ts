import { waitForRequiredSetup } from '../../../../../../workspaces/startup/required-setup-completion'

import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import type { WorkerEffect, WorkerSetupReceipt } from '../placement/worker-placement-topology'

export type WorkerSetupGate = {
  satisfied: boolean
  status: string
  /** A setup gate has no agent prompt to block on; declared so the wait union stays property-typed. */
  blockedReason?: undefined
}

export async function awaitWorkerSetupGate(args: {
  runtime: Pick<OrcaRuntimeService, 'waitForSetupTerminalCompletion'>
  setup: WorkerSetupReceipt
  effects: WorkerEffect[]
}): Promise<WorkerSetupGate | null> {
  if (args.setup.startupPolicy !== 'wait-for-setup' || args.setup.state !== 'running') {
    return null
  }
  const setupTerminal = args.effects.find((effect) => effect.kind === 'setup')?.terminalId
  if (!setupTerminal) {
    return { satisfied: false, status: 'exited' }
  }
  try {
    await waitForRequiredSetup(
      args.runtime,
      { ...args.setup, terminalHandle: setupTerminal },
      'Agent'
    )
    return { satisfied: true, status: 'exited' }
  } catch {
    return { satisfied: false, status: 'exited' }
  }
}
