// How a durable session record becomes a ZCode process launch.
//
// Every input is read back from the record the store already made durable, not
// from the call that triggered the acquire. A resume names the session this
// record actually proved — the provider-handle chain head — never one a caller
// asks for, which is how a resume becomes a fork wearing a resume's name.
//
// The directory, the identity keys and the spawn token are the shared composition's
// (`composeStructuredLaunch` / `sealStructuredSessionChild`); this is ZCode's own part:
// its account home, its binary, and what its child must not inherit.

import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import type { StructuredAgentCommandSettings } from '../native-chat/structured-agent-command-resolution'
import type { StructuredAgentLaunchPartResolver } from '../runtime/structured-agent-launch-composition'
import { STRUCTURED_CHILD_ENV_TO_DELETE } from '../runtime/structured-session-child-env'
import { resolveZcodeCliInvocation, type ZcodeCliInvocation } from './zcode-cli-invocation'
import { ZCODE_STRUCTURED_AGENT } from './zcode-structured-agent-definition'

export type ZcodeStructuredLaunch = {
  command: string
  args: string[]
  /** Present when the record's handle chain holds a head: the ZCode session id to resume. */
  resumeSessionId: string | null
  /** The workspace directory the session's `session/create` names. */
  workspacePath: string
}

export type ZcodeStructuredLaunchPartDeps = {
  resolveInvocation?: typeof resolveZcodeCliInvocation
}

function resolveInvocation(
  environment: Record<string, string>,
  commandSettings: StructuredAgentCommandSettings,
  deps: ZcodeStructuredLaunchPartDeps
): ZcodeCliInvocation {
  const pathEnv = environment.PATH ?? environment.Path
  const homePath = environment.HOME ?? environment.USERPROFILE
  return (deps.resolveInvocation ?? resolveZcodeCliInvocation)({
    commandSettings,
    ...(pathEnv ? { pathEnv } : {}),
    ...(homePath ? { homePath } : {})
  })
}

export function zcodeAppServerArgs(invocation: ZcodeCliInvocation): string[] {
  return [
    ...invocation.prefixArgs,
    'app-server',
    '--stdio',
    ...(invocation.source === 'desktop-bundle' ? ['--surface', 'desktop'] : [])
  ]
}

/** ZCode's part of a launch: its `ZCODE_HOME`, the app-server binary, and the resume it proved. */
export function zcodeStructuredLaunchPart(
  deps: ZcodeStructuredLaunchPartDeps = {}
): StructuredAgentLaunchPartResolver<ZcodeStructuredLaunch> {
  return async (basis) => {
    const { record } = basis
    const accountHome = requireLegacyAgentSessionAccountHome(record.accountHome)
    const pinned = ZCODE_STRUCTURED_AGENT.accountHomeVariable
    if (accountHome.variable !== pinned) {
      throw new Error(`zcode sessions pin ${pinned}, not ${accountHome.variable}`)
    }
    const environment = await basis.environment()
    const invocation = resolveInvocation(environment, basis.commandSettings(), deps)
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    return {
      launch: {
        command: invocation.command,
        args: zcodeAppServerArgs(invocation),
        resumeSessionId: head?.handle.nativeId ?? null,
        workspacePath: await basis.launchDirectory()
      },
      env: {
        ...environment,
        ZCODE_HOME: accountHome.path,
        ...invocation.envOverlay
      },
      inheritedEnvToDelete: STRUCTURED_CHILD_ENV_TO_DELETE
    }
  }
}

/** The app-server program an installed Desktop app or standalone CLI exposes. */
export function resolveZcodeChatProgram(
  environment: Record<string, string>,
  commandSettings: StructuredAgentCommandSettings,
  deps: ZcodeStructuredLaunchPartDeps = {}
): { command: string; env: Record<string, string> } {
  const invocation = resolveInvocation(environment, commandSettings, deps)
  return {
    command: invocation.command,
    env: { ...environment, ...invocation.envOverlay }
  }
}
