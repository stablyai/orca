// Prompt-like turn commands (prompt/steer/follow_up) and the extension-UI
// reply, extracted from OmpRpcClient to mirror OmpRpcSessionCommands's
// composition pattern.

import type {
  OmpRpcCommand,
  OmpRpcExtensionUiResponse,
  OmpRpcImageContent,
  OmpRpcStreamingBehavior
} from '../../shared/omp-rpc-protocol'
import { isOmpRpcObject } from './omp-rpc-frame-validation'

type OmpRpcTurnCommandDependencies = {
  whenReady: () => Promise<unknown>
  /** `requestId` pins the wire `id` so the caller can correlate a later
   *  server-pushed frame with this exact command. */
  sendCommand: (command: OmpRpcCommand, requestId?: string) => Promise<unknown>
  /** Raw stdin write bypassing command correlation (an extension_ui_response
   *  answers a server-issued request by its own `id`, not a pending command). */
  writeRaw: (frame: OmpRpcExtensionUiResponse) => boolean
}

function agentInvokedResult(data: unknown): { agentInvoked: boolean } {
  return {
    agentInvoked:
      isOmpRpcObject(data) && typeof data.agentInvoked === 'boolean' ? data.agentInvoked : true
  }
}

export class OmpRpcTurnCommands {
  constructor(private readonly dependencies: OmpRpcTurnCommandDependencies) {}

  readonly prompt = async (
    message: string,
    options?: {
      images?: OmpRpcImageContent[]
      streamingBehavior?: OmpRpcStreamingBehavior
      requestId?: string
    }
  ): Promise<{ agentInvoked: boolean }> => {
    await this.dependencies.whenReady()
    const data = await this.dependencies.sendCommand(
      {
        type: 'prompt',
        message,
        ...(options?.images ? { images: options.images } : {}),
        ...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {})
      },
      options?.requestId
    )
    return agentInvokedResult(data)
  }

  readonly steer = async (
    message: string,
    images?: OmpRpcImageContent[]
  ): Promise<{ agentInvoked: boolean }> => {
    await this.dependencies.whenReady()
    const data = await this.dependencies.sendCommand({
      type: 'steer',
      message,
      ...(images ? { images } : {})
    })
    return agentInvokedResult(data)
  }

  readonly followUp = async (
    message: string,
    images?: OmpRpcImageContent[]
  ): Promise<{ agentInvoked: boolean }> => {
    await this.dependencies.whenReady()
    const data = await this.dependencies.sendCommand({
      type: 'follow_up',
      message,
      ...(images ? { images } : {})
    })
    return agentInvokedResult(data)
  }

  readonly respondExtensionUi = (response: OmpRpcExtensionUiResponse): boolean => {
    return this.dependencies.writeRaw(response)
  }
}
