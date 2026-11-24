import { OrcaRuntimeWithAgentQuestions } from './orca-runtime-agent-questions'
import { PipelineRuntime } from '../pipelines/pipeline-runtime'
import type { OrcaRuntimeService } from '../orca-runtime'

export abstract class OrcaRuntimeWithPipelines extends OrcaRuntimeWithAgentQuestions {
  protected abstract get pipelineHost(): OrcaRuntimeService
  private _pipelineRuntime?: PipelineRuntime
  peekPipelineRuntime(): PipelineRuntime | undefined {
    return this._pipelineRuntime
  }
  get pipelineRuntime(): PipelineRuntime {
    return (this._pipelineRuntime ??= new PipelineRuntime(this.pipelineHost, (event) =>
      this.emitClientEvent(event)
    ))
  }
}
