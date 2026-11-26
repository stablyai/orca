import { z } from 'zod'
import type { NativeChatSignInRequest } from '../../../../src/shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import { parseRoutableExecutionHostId } from '../../../../src/shared/execution-host/execution-host'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import type { MobileSessionController } from '../use-mobile-session-controller'

export type NativeChatTerminalRunner = (command: string, signIn: NativeChatSignInRequest) => void

const prepareSignIn = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'preflight.prepare-native-chat-sign-in',
    method: 'preflight.detectAgents',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('sign-in-command', z.object({ preparedCommand: z.string().nullable() }))
  })
)

/** A chat's "Run in terminal": a new terminal runs the command once its shell is ready. */
export function nativeChatTerminalRunner(
  controller: Pick<
    MobileSessionController,
    'worktreeId' | 'worktreeHostId' | 'handleCreateTerminal'
  >
): NativeChatTerminalRunner {
  return (command, nativeChatSignIn) => {
    void controller.handleCreateTerminal(undefined, {
      prepareStartupCommand: async (client) => {
        const host = parseRoutableExecutionHostId(controller.worktreeHostId)
        const prepared = await prepareSignIn
          .request(client, {
            worktreeId: controller.worktreeId,
            ...(host ? { worktreeHostId: host.id } : {}),
            nativeChatSignIn
          })
          .then(prepareSignIn.interpret)
          .catch(() => null)
        return prepared?.preparedCommand ?? command
      },
      startupCommandDelivery: 'shell-ready',
      terminalView: true
    })
  }
}
