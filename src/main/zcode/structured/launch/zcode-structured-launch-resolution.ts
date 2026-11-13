import { agentSessionProviderHandleChainHead } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { agentSessionProviderHandleKey } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { pendingAgentSessionRewindFork } from '../../../../shared/agent-session/lifecycle/agent-session-rewind'
import {
  resolveStructuredAgentCommand,
  type StructuredAgentCommand
} from '../../../native-chat/agent-launch/structured-agent-command-resolution'
import type { StructuredAgentLaunchPartResolver } from '../../../runtime/agent-session/launch/structured-agent-launch-composition'
import {
  LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV,
  NATIVE_CHAT_SCRATCH_DIR_ENV
} from '../../../native-chat/conversation-files/native-chat-visuals-delivery'
import { zcodeStructuredLaunchArgs } from './zcode-structured-launch-args'
import {
  readBundledZcodeAppVersion,
  zcodeBundledLaunch,
  zcodeProviderEnv
} from './zcode-runtime-resolution'
import type {
  ZcodeLaunchModel,
  ZcodeStructuredLaunch
} from '../session-lifecycle/zcode-structured-session-state'

export const ZCODE_APP_SERVER_ARGS = ['app-server', '--stdio'] as const

export type ZcodeStructuredLaunchPartDeps = {
  resolveLaunchArgs: () => Promise<string[]> | string[]
  resolveCommand?: (options?: {
    pathEnv?: string | null
    homePath?: string
  }) => StructuredAgentCommand
}

/**
 * Parse a model option value (`providerId/modelId`) back into a session/create selection.
 * Values without the separator are not zcode selections and launch with zcode's own default.
 */
export function parseZcodeModelOption(value: string): ZcodeLaunchModel | null {
  const separator = value.indexOf('/')
  if (separator <= 0 || separator === value.length - 1) {
    return null
  }
  const providerId = value.slice(0, separator)
  const modelId = value.slice(separator + 1)
  return /^[a-z0-9:_-]+$/i.test(providerId) && /^[A-Za-z0-9._-]+$/.test(modelId)
    ? { providerId, modelId }
    : null
}

export function formatZcodeModelOption(model: { providerId: string; modelId: string }): string {
  return `${model.providerId}/${model.modelId}`
}

/**
 * ZCode desktop's own runtime env (ZCODE_SESSION_ID, ZCODE_BASE_URL, …) leaks into every process
 * it hosts. A chat backend that inherits them boots as a managed desktop surface — its
 * session/create schema differs and the push is refused — so a headless chat strips them all,
 * keeping only user-set overrides and the provider tables the launch adds itself.
 */
const ZCODE_INHERITED_ENV_KEEP = new Set(['ZCODE_HOME', 'ZCODE_CREDENTIAL_SECRET'])

/** Derive resume identity from the durable record; zcode pins its own account home. */
export function zcodeStructuredLaunchPart(
  deps: ZcodeStructuredLaunchPartDeps
): StructuredAgentLaunchPartResolver<ZcodeStructuredLaunch> {
  return async (basis) => {
    const { record } = basis
    const environment = await basis.environment()
    const args = [
      ...zcodeStructuredLaunchArgs(await deps.resolveLaunchArgs()),
      ...ZCODE_APP_SERVER_ARGS
    ]
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    // The desktop bundle's runtime is the primary chat backend (it accepts the host's account
    // push); resolve the CLI only where no bundle is installed — a WSL host can lack the CLI
    // while the bundle still works, and CLI resolution throws cliMissing there.
    const bundled = zcodeBundledLaunch(environment.PATH ?? environment.Path)
    const resolved = bundled
      ? null
      : deps.resolveCommand
        ? deps.resolveCommand({
            pathEnv: environment.PATH ?? environment.Path ?? null,
            ...(environment.HOME ? { homePath: environment.HOME } : {})
          })
        : resolveStructuredAgentCommand('zcode', basis.commandSettings(), {
            pathEnv: environment.PATH ?? environment.Path ?? null,
            ...(environment.HOME ? { homePath: environment.HOME } : {})
          })
    // A refusal to be retried on the same binary is not a fallback; only the bundle's CLI
    // sibling (which accepts host pushes the wrapper refuses) is one.
    const cliFallback = null
    // The provider tables follow the runtime that actually boots: the bundle's own table for a
    // bundled launch, the CLI's for a CLI launch.
    const providerEnv = zcodeProviderEnv(
      bundled ? (bundled.args[0] ?? resolved?.command ?? 'zcode') : (resolved?.command ?? 'zcode')
    )
    if (providerEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE === undefined) {
      // A .cjs runtime without a builtin table next to it still needs an app version for the
      // gateway's User-Agent check; the entry name itself is the identity here.
      const version = readBundledZcodeAppVersion(
        bundled ? (bundled.args[0] ?? resolved?.command) : (resolved?.command ?? 'zcode')
      )
      if (version) {
        providerEnv.ZCODE_APP_VERSION = version
      }
    }
    const model = parseZcodeModelOption(record.options?.model ?? '')
    const desktopEnvKeys = Object.keys(environment).filter(
      (key) => key.startsWith('ZCODE_') && !ZCODE_INHERITED_ENV_KEEP.has(key)
    )
    const env = { ...environment }
    for (const key of desktopEnvKeys) {
      delete env[key]
    }
    const command = bundled
      ? {
          command: bundled.command,
          prefixArgs: bundled.prefixArgs,
          args: [...bundled.args, ...args]
        }
      : {
          command: resolved!.command,
          prefixArgs: resolved!.prefixArgs,
          args: [...resolved!.prefixArgs, ...args]
        }
    return {
      launch: {
        command: command.command,
        prefixArgs: command.prefixArgs,
        args: command.args,
        ...(basis.permissionMode === 'own'
          ? {}
          : { permissionMode: basis.permissionMode ?? 'ask' }),
        model: model ? withSavedEffort(model, record.options?.effort) : null,
        // An owed rewind fork outranks the head: the chat continues in the fork zcode built, and
        // the open must report that continuation as a fork of the head the chain still holds.
        resumeSessionId:
          pendingAgentSessionRewindFork(record.rewind, head?.handle.nativeId)?.sessionId ??
          head?.handle.nativeId ??
          null,
        ...(head && pendingAgentSessionRewindFork(record.rewind, head.handle.nativeId)
          ? { forkedFromKey: agentSessionProviderHandleKey(head.handle) }
          : {}),
        providerEnv,
        fallbackRuntime: cliFallback
      },
      env,
      // Clear the enclosing desktop's runtime env plus inherited scratch paths.
      inheritedEnvToDelete: [
        ...desktopEnvKeys,
        NATIVE_CHAT_SCRATCH_DIR_ENV,
        LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV
      ],
      cliRuntimeCommand: resolved?.command
    }
  }
}

function withSavedEffort(model: ZcodeLaunchModel, effort: string | undefined): ZcodeLaunchModel {
  return effort ? { ...model, reasoningLevel: effort } : model
}
