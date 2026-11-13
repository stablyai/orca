import type {
  TextGenerateRequest,
  TextGenerateResult
} from '../../../../shared/rpc-contract/text-params'
import {
  generateAgentText,
  type AgentTextGenerationHost
} from '../../../text-generation/agent-text-generation-request'

export class RuntimeTextCommands {
  constructor(private readonly host: AgentTextGenerationHost) {}

  textGenerate(args: TextGenerateRequest, signal?: AbortSignal): Promise<TextGenerateResult> {
    return generateAgentText(this.host, args, signal)
  }
}
