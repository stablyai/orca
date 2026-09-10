import type {
  OmpRpcCommand,
  OmpRpcHistoryResult,
  OmpRpcMessagesPage,
  OmpRpcSessionState
} from '../../shared/omp-rpc-protocol'
import type { OmpRpcSubagentSubscriptionLevel } from '../../shared/omp-rpc-subagent-protocol'
import { OMP_RPC_SUBAGENT_SUBSCRIPTION_LEVELS } from '../../shared/omp-rpc-subagent-protocol'
import {
  isOmpRpcObject,
  parseOmpRpcMessagesPage,
  parseOmpRpcSessionState
} from './omp-rpc-frame-validation'
import { drainOmpRpcHistory } from './omp-rpc-history-page'

type OmpRpcSessionCommandDependencies = {
  whenReady: () => Promise<unknown>
  sendCommand: (command: OmpRpcCommand) => Promise<unknown>
}

export class OmpRpcSessionCommands {
  constructor(private readonly dependencies: OmpRpcSessionCommandDependencies) {}

  readonly getState = async (): Promise<OmpRpcSessionState> => {
    await this.dependencies.whenReady()
    return parseOmpRpcSessionState(await this.dependencies.sendCommand({ type: 'get_state' }))
  }

  readonly getMessagesPage = async (
    options: { cursor?: string; limit?: number } = {}
  ): Promise<OmpRpcMessagesPage> => {
    await this.dependencies.whenReady()
    return parseOmpRpcMessagesPage(
      await this.dependencies.sendCommand({
        type: 'get_messages_page',
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        ...(options.limit === undefined ? {} : { limit: options.limit })
      })
    )
  }

  readonly fetchHistory = (options: { limit?: number } = {}): Promise<OmpRpcHistoryResult> =>
    drainOmpRpcHistory((pageOptions) => this.getMessagesPage(pageOptions), options)

  readonly switchSession = async (sessionPath: string): Promise<void> => {
    if (!sessionPath.trim()) {
      throw new Error('OMP RPC session path is required')
    }
    await this.dependencies.whenReady()
    await this.dependencies.sendCommand({ type: 'switch_session', sessionPath })
  }

  /** Reports the level the SERVER selected, read back off its own response,
   *  rather than echoing the requested one: forwarding stays off if the level
   *  did not take, and a caller that assumed otherwise would wait forever for
   *  frames that are never coming. */
  readonly setSubagentSubscription = async (
    level: OmpRpcSubagentSubscriptionLevel
  ): Promise<OmpRpcSubagentSubscriptionLevel> => {
    await this.dependencies.whenReady()
    const data = await this.dependencies.sendCommand({
      type: 'set_subagent_subscription',
      level
    })
    const selected = isOmpRpcObject(data) ? data.level : undefined
    if (
      typeof selected !== 'string' ||
      !OMP_RPC_SUBAGENT_SUBSCRIPTION_LEVELS.includes(selected as OmpRpcSubagentSubscriptionLevel)
    ) {
      throw new Error('OMP RPC subagent subscription response was malformed')
    }
    return selected as OmpRpcSubagentSubscriptionLevel
  }

  readonly abort = async (): Promise<void> => {
    await this.dependencies.whenReady()
    await this.dependencies.sendCommand({ type: 'abort' })
  }
}
