export type PipelineIterationLoopStatus = 'completed' | 'failed' | 'cancelled'

export type PipelineIterationLoopStopReason =
  | 'empty_plan'
  | 'no_progress'
  | 'max_iterations'
  | 'failed'
  | 'cancelled'

export type PipelineIterationLoopResult = {
  iterationNumber: number
  status: PipelineIterationLoopStatus
  plannedTaskCount: number
  completedTaskCount: number
}

export type PipelineIterationLoopStepResult = Omit<PipelineIterationLoopResult, 'iterationNumber'>

export type RunPipelineIterationLoopInput = {
  maxIterations: number
  runIteration: (iterationNumber: number) => Promise<PipelineIterationLoopStepResult>
}

export async function runPipelineIterationLoop(input: RunPipelineIterationLoopInput): Promise<{
  stopReason: PipelineIterationLoopStopReason
  iterations: PipelineIterationLoopResult[]
}> {
  const iterations: PipelineIterationLoopResult[] = []

  for (let iterationNumber = 1; iterationNumber <= input.maxIterations; iterationNumber++) {
    const result = { ...(await input.runIteration(iterationNumber)), iterationNumber }
    iterations.push(result)

    if (result.status === 'failed') {
      return { stopReason: 'failed', iterations }
    }
    if (result.status === 'cancelled') {
      return { stopReason: 'cancelled', iterations }
    }
    if (result.plannedTaskCount === 0) {
      return { stopReason: 'empty_plan', iterations }
    }
    if (result.completedTaskCount === 0) {
      return { stopReason: 'no_progress', iterations }
    }
  }

  return { stopReason: 'max_iterations', iterations }
}
