import type { StructuredAgentSessionConversationLifetimeHost } from './structured-agent-session-conversation-lifetime-host'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import type {
  AgentSessionSwitchDeadline,
  AgentSessionSwitchResult,
  AgentSessionSwitchReceipt
} from '../../../shared/agent-session-switch-execution'
import {
  selectStructuredSessionSwitchCommand,
  type SwitchCommand
} from './structured-agent-session-switch-command-selection'

export function createStructuredAgentSessionSwitchCommands(
  host: StructuredAgentSessionConversationLifetimeHost,
  isDisposed: () => boolean
) {
  const { serialize } = host
  const deps = () => host.context().deps
  const commands = new Map<string, SwitchCommand>()
  const unsubscribeAcceptance = deps().store.onAcceptedSend((id) => {
    const command = commands.get(id)
    if (!command?.revokeOnSend || command.settled) {
      return
    }
    command.deadline.revoke(
      agentSessionRefusalError('agent_session_operation_invalid', {
        reason: 'messagesUnsettled'
      })
    )
  })

  return {
    controls: {
      runSwitch: async (
        id: string,
        invocationId: string,
        deadline: AgentSessionSwitchDeadline,
        run: () => Promise<AgentSessionSwitchResult>,
        revokeOnSend = true,
        phase?: {
          observe?: boolean
          receipt?: AgentSessionSwitchReceipt
        },
        onRetained?: (check: () => void) => Promise<void>,
        allowUncreated = false,
        onConverged?: (generation: string) => void
      ): Promise<AgentSessionSwitchResult> => {
        const selected = await deadline.wait(
          serialize(id, async () => {
            return selectStructuredSessionSwitchCommand({
              host,
              commands,
              isDisposed,
              id,
              invocationId,
              deadline,
              run,
              revokeOnSend,
              phase,
              onRetained,
              allowUncreated
            })
          })
        )
        if (selected.deadline !== deadline) {
          deadline.dispose()
        }
        if (phase?.receipt) {
          if (phase.receipt.generation !== selected.generation) {
            throw agentSessionRefusalError('agent_session_operation_invalid', {
              reason: 'handoffInFlight'
            })
          }
          if (phase.receipt.converged) {
            onConverged?.(selected.generation)
            return { status: 'completed', sessionId: id }
          }
          if (phase.receipt.retained) {
            selected.deadline.revoke(
              agentSessionRefusalError('agent_session_operation_invalid', {
                reason: 'messagesUnsettled'
              })
            )
            await selected.retain?.()
            return { status: 'completed', sessionId: id, sourceRetained: true }
          }
          selected.deadline.check()
          selected.acknowledge(phase.receipt.shown)
          return Promise.race([selected.completion, selected.opened])
        }
        return phase?.observe
          ? selected.completion
          : Promise.race([selected.completion, selected.presentation])
      },
      adoptSwitch: (from: string, to: string) =>
        serialize(to, async () => {
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
      switchGeneration: (id: string) => commands.get(id)?.generation,
      retainSwitch: async (id: string) => {
        await commands.get(id)?.retain?.()
      },
      presentSwitch: async (
        id: string,
        view: Omit<
          Extract<AgentSessionSwitchResult, { status: 'present' }>,
          'status' | 'generation'
        >
      ) => {
        const command = commands.get(id)
        if (!command) {
          throw agentSessionRefusalError('agent_session_operation_expired', {
            reason: 'operationExpired'
          })
        }
        command.deadline.check()
        command.present({ ...view, status: 'present', generation: command.generation })
        if (!(await command.deadline.wait(command.shown))) {
          throw agentSessionRefusalError('agent_session_operation_unknown', {
            reason: 'tabUnconfirmed'
          })
        }
        command.deadline.check()
      },
      openedSwitch: (id: string, result: AgentSessionSwitchResult) =>
        commands.get(id)?.openedResult(result),
      switchExecuting: (id: string) => Boolean(commands.get(id) && !commands.get(id)?.settled),
      trackSwitchPhysical: <T>(id: string, work: Promise<T>): Promise<T> => {
        const command = commands.get(id)
        if (command) {
          command.physical = work.then(
            () => {},
            () => {}
          )
        }
        return work
      },
      waitSwitchPhysical: async (id: string): Promise<void> => {
        await commands.get(id)?.physical
      }
    },
    revoke: (id: string) => {
      const command = commands.get(id)
      if (command) {
        command.retentionAllowed = false
        command.deadline.revoke()
      }
    },
    dispose: () => {
      unsubscribeAcceptance()
      for (const command of commands.values()) {
        command.retentionAllowed = false
        clearTimeout(command.cleanupTimer)
        command.deadline.revoke()
      }
      commands.clear()
    }
  }
}
