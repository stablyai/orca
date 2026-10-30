import type { StructuredAgentSessionConversationLifetimeHost } from './structured-agent-session-conversation-lifetime-host'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import type {
  AgentSessionSwitchDeadline,
  AgentSessionSwitchResult
} from '../../../shared/agent-session-switch-execution'
import {
  selectStructuredSessionSwitchCommand,
  type SwitchCommand
} from './structured-agent-session-switch-command-selection'

export function createStructuredAgentSessionSwitchCommands(
  host: StructuredAgentSessionConversationLifetimeHost,
  isDisposed: () => boolean
) {
  const commands = new Map<string, SwitchCommand>()
  const unsubscribe = host.context().deps.store.onAcceptedSend((id) => {
    const command = commands.get(id)
    if (command?.workCurrent && !command.settled && !command.workCurrent()) {
      command.deadline.revoke(
        agentSessionRefusalError('agent_session_operation_invalid', { reason: 'messagesUnsettled' })
      )
    }
  })
  return {
    controls: {
      runSwitch: async (
        id: string,
        invocationId: string,
        deadline: AgentSessionSwitchDeadline,
        run: () => Promise<AgentSessionSwitchResult>,
        options: {
          conversationKey?: string
          direction: SwitchCommand['direction']
          allowUncreated?: boolean
          destinationCurrent?: (result: AgentSessionSwitchResult) => boolean | undefined
          onAccepted?: () => void
        }
      ): Promise<AgentSessionSwitchResult> => {
        const selected = await deadline
          .wait(
            host.serialize(options.conversationKey ?? id, async () =>
              selectStructuredSessionSwitchCommand({
                host,
                commands,
                isDisposed,
                id,
                invocationId,
                deadline,
                run,
                ...options
              })
            )
          )
          .catch((error: unknown) => {
            deadline.dispose()
            throw error
          })
        if (selected.deadline !== deadline) {
          deadline.dispose()
        }
        return selected.completion
      },
      adoptSwitch: (from: string, to: string) =>
        host.serialize(to, async () => {
          const command = commands.get(from)
          const prior = commands.get(to)
          command?.deadline.check()
          if (!command || (prior && prior !== command && !prior.settled)) {
            throw agentSessionRefusalError('agent_session_operation_invalid', {
              reason: 'handoffInFlight'
            })
          }
          commands.set(to, command)
        }),
      guardSwitchWork: (id: string, current: () => boolean) => {
        const command = commands.get(id)
        if (command) {
          command.workCurrent = current
        }
      },
      switchGeneration: (id: string) => commands.get(id)?.generation,
      switchExecuting: (id: string) => Boolean(commands.get(id) && !commands.get(id)?.settled),
      /** Stop and spawn work already dispatched settles even when the observing request expired. */
      trackSwitchPhysical: <T>(id: string, work: Promise<T>): Promise<T> => {
        const command = commands.get(id)
        if (command) {
          command.physical = Promise.allSettled([command.physical, work]).then(() => {})
        }
        return work
      },
      waitSwitchPhysical: async (id: string): Promise<void> => {
        await commands.get(id)?.physical
      }
    },
    revoke: (id: string): boolean => {
      const command = commands.get(id)
      if (!command) {
        return false
      }
      command.deadline.revoke()
      return true
    },
    dispose: () => {
      unsubscribe()
      for (const command of commands.values()) {
        clearTimeout(command.cleanupTimer)
        command.deadline.revoke()
      }
      commands.clear()
    }
  }
}
