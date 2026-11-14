import {
  recognizeAgentProcess,
  isAgentForegroundWrapperProcess
} from '../../../../shared/agent-status/process/agent-process-recognition'
import { isShellProcess } from '../../../../shared/agent-status/process/shell-process-detection'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { PtyForegroundProcessRead } from './pty-foreground-observation-state'
import { classifyTerminalProcessInspectionFailure } from '../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import { isTerminalForegroundObservation } from '../../../../shared/terminal/pty/lifecycle/terminal-foreground-observation'

export async function readPtyForegroundObservation(
  controller: RuntimePtyController,
  ptyId: string,
  incarnation: string | null | undefined,
  isCurrent: () => boolean
): Promise<PtyForegroundProcessRead> {
  if (controller.supportsForegroundObservation?.(ptyId) === false) {
    return { controller, process: null, available: false, unsupported: true }
  }
  if (!controller.inspectProcess) {
    return confirmStartupAgent(
      { controller, process: await controller.getForegroundProcess(ptyId), available: true },
      ptyId,
      isCurrent
    )
  }
  let inspection
  try {
    inspection = await controller.inspectProcess(ptyId, {
      foregroundOnly: true,
      ...(incarnation ? { expectedIncarnationId: incarnation } : {})
    })
  } catch (error) {
    return {
      controller,
      process: null,
      available: false,
      unsupported: classifyTerminalProcessInspectionFailure(error) === 'old_host'
    }
  }
  if (inspection.verdict === 'unverifiable' && inspection.reason === 'old_host') {
    return { controller, process: null, available: false, unsupported: true }
  }
  const observation = inspection.foregroundObservation
  if (
    !isTerminalForegroundObservation(observation) ||
    observation.ptyId !== ptyId ||
    (incarnation && observation.ptyIncarnationId !== incarnation)
  ) {
    return { controller, process: null, available: false }
  }
  return confirmStartupAgent(
    {
      controller,
      process: observation.verdict === 'observed' ? observation.processName : null,
      available: true,
      observation
    },
    ptyId,
    isCurrent
  )
}

async function confirmStartupAgent(
  sample: PtyForegroundProcessRead,
  ptyId: string,
  isCurrent: () => boolean
): Promise<PtyForegroundProcessRead> {
  let agent = recognizeAgentProcess(sample.process)?.agent
  if (
    !agent &&
    sample.process &&
    !isShellProcess(sample.process) &&
    isCurrent() &&
    (isAgentForegroundWrapperProcess(sample.process) || /^\d+\.\d+\.\d+$/.test(sample.process))
  ) {
    agent = (await confirmPtyForegroundAgent(sample.controller, ptyId)) ?? undefined
  }
  return agent ? { ...sample, agent } : sample
}

export async function confirmPtyForegroundAgent(
  controller: RuntimePtyController,
  ptyId: string
): Promise<TerminalAgent | null> {
  try {
    return recognizeAgentProcess(await controller.confirmForegroundProcess?.(ptyId))?.agent ?? null
  } catch {
    return null
  }
}
