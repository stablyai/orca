import {
  LOCAL_COMMAND_ERRORS,
  LOCAL_COMMANDS_ATTACH_METHOD,
  LOCAL_COMMANDS_REQUEST_METHOD,
  LOCAL_COMMANDS_SETTLE_METHOD,
  LOCAL_COMMANDS_STATUS_METHOD,
  LocalCommandAttachParamsSchema,
  LocalCommandIdParamsSchema,
  LocalCommandRequestParamsSchema,
  LocalCommandSettleParamsSchema,
  type LocalCommandRequestResult,
  type LocalCommandSettleResult,
  type LocalCommandStatusResult
} from '../../../../../shared/local-commands/local-command-contract'
import {
  getLocalCommandBroker,
  LocalCommandError,
  type LocalCommandBroker
} from '../../../local-commands/local-command-broker'
import { isCloudWorkspaceOrcad } from '../../../secrets/session-env-names'
import { isGrantedDevice } from '../../../local-commands/grant-device-ledger'
import { defineMethod, defineStreamingMethod, type RpcContext } from '../../core'
import { isAgentRpcCaller } from '../../rpc-caller-identity'
import { resolveSecretRequestCaller } from '../secrets/secret-requests'
import { verifiedCallerTerminalHandle } from '../orchestration/turn-sender'

export type LocalCommandMethodDeps = {
  broker: () => LocalCommandBroker
  /** Only a cloud workspace's orcad relays; a desktop's own runtime refuses. */
  enabled: () => boolean
  callerTerminal: (ctx: RpcContext) => string | null
  /** Devices paired through a grant (teammates, other computers) never take requests. */
  isGrantedDevice: (originDeviceId: string) => Promise<boolean>
}

const defaultDeps: LocalCommandMethodDeps = {
  broker: getLocalCommandBroker,
  enabled: () => isCloudWorkspaceOrcad(),
  callerTerminal: verifiedCallerTerminalHandle,
  isGrantedDevice: (originDeviceId) => isGrantedDevice(originDeviceId)
}

/** A paired desktop, proven by its socket: never the agent's CLI, a phone, or a device paired through
 *  a grant (best effort, see grant-device-ledger.ts). The desktop re-checks ownership itself. */
async function requireOwnerDesktop(
  ctx: RpcContext,
  deps: LocalCommandMethodDeps
): Promise<{ deviceId: string; connectionId: string }> {
  if (
    ctx.clientKind !== 'runtime' ||
    ctx.caller?.kind !== 'paired-device' ||
    !ctx.pairedDeviceId ||
    !ctx.pairedDeviceOriginId ||
    !ctx.connectionId ||
    (await deps.isGrantedDevice(ctx.pairedDeviceOriginId))
  ) {
    throw new LocalCommandError(LOCAL_COMMAND_ERRORS.forbidden)
  }
  return { deviceId: ctx.pairedDeviceId, connectionId: ctx.connectionId }
}

let attachSeq = 0

export function createLocalCommandMethods(deps: LocalCommandMethodDeps = defaultDeps) {
  const broker = (): LocalCommandBroker => {
    if (!deps.enabled()) {
      throw new LocalCommandError(LOCAL_COMMAND_ERRORS.unavailable)
    }
    return deps.broker()
  }
  return [
    defineMethod({
      name: LOCAL_COMMANDS_REQUEST_METHOD,
      permission: 'workspace',
      params: LocalCommandRequestParamsSchema,
      handler: async (params, ctx): Promise<LocalCommandRequestResult> => {
        // Agents ask through the CLI on this VM; a person's device has its own computer to use.
        if (!isAgentRpcCaller(ctx.caller)) {
          throw new LocalCommandError(LOCAL_COMMAND_ERRORS.forbidden)
        }
        const relay = broker()
        const caller = await resolveSecretRequestCaller(
          ctx.runtime,
          deps.callerTerminal(ctx),
          params.worktreeId
        )
        return relay.request({
          command: params.command,
          cwd: params.cwd ?? null,
          timeoutSec: params.timeoutSec,
          reason: params.reason || null,
          agent: caller.agent
        })
      }
    }),
    defineMethod({
      name: LOCAL_COMMANDS_STATUS_METHOD,
      permission: 'workspace',
      params: LocalCommandIdParamsSchema,
      handler: async (params, ctx): Promise<LocalCommandStatusResult> => {
        if (!isAgentRpcCaller(ctx.caller)) {
          throw new LocalCommandError(LOCAL_COMMAND_ERRORS.forbidden)
        }
        return broker().status(params.requestId)
      }
    }),
    defineMethod({
      name: LOCAL_COMMANDS_SETTLE_METHOD,
      permission: 'workspace',
      params: LocalCommandSettleParamsSchema,
      handler: async (params, ctx): Promise<LocalCommandSettleResult> => {
        const { deviceId } = await requireOwnerDesktop(ctx, deps)
        return broker().settle(deviceId, params)
      }
    }),
    defineStreamingMethod({
      name: LOCAL_COMMANDS_ATTACH_METHOD,
      permission: 'workspace',
      params: LocalCommandAttachParamsSchema,
      handler: async (_params, ctx, emit) => {
        const { deviceId, connectionId } = await requireOwnerDesktop(ctx, deps)
        const relay = broker()
        await new Promise<void>((resolve) => {
          const subscriptionId = `local-commands-${connectionId}-${++attachSeq}`
          let detach = (): void => {}
          let done = false
          const cleanup = (): void => {
            if (done) {
              return
            }
            done = true
            detach()
            emit({ type: 'end' })
            resolve()
          }
          ctx.runtime.registerSubscriptionCleanup(subscriptionId, cleanup, connectionId)
          ctx.signal?.addEventListener('abort', cleanup, { once: true })
          if (ctx.signal?.aborted) {
            cleanup()
            return
          }
          detach = relay.attach(subscriptionId, deviceId, emit)
        })
      }
    })
  ] as const
}

export const LOCAL_COMMAND_METHODS = createLocalCommandMethods()
