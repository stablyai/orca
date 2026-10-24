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
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import type { StructuredAgentLaunchPartResolver } from '../runtime/structured-agent-launch-composition'
import { STRUCTURED_CHILD_ENV_TO_DELETE } from '../runtime/structured-session-child-env'
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
  /** Overridden in tests; production scans the boot-cached PATH and version-manager dirs. */
  resolveCommand?: (options?: { pathEnv?: string | null; homePath?: string }) => string
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
    const pathEnv = environment.PATH ?? environment.Path ?? null
    const homePath = environment.HOME ?? environment.USERPROFILE
    const command = (deps.resolveCommand ?? resolveZcodeCommand)({
      pathEnv,
      ...(homePath ? { homePath } : {})
    })
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    return {
      launch: {
        command,
        args: ['app-server', '--stdio'],
        resumeSessionId: head?.handle.nativeId ?? null,
        workspacePath: await basis.launchDirectory()
      },
      env: { ...environment, ZCODE_HOME: accountHome.path },
      inheritedEnvToDelete: STRUCTURED_CHILD_ENV_TO_DELETE
    }
  }
}

/** PATH first, then the version-manager and system install directories the shared resolver scans. */
export function resolveZcodeCommand(options?: {
  pathEnv?: string | null
  homePath?: string
}): string {
  return resolveCliCommand('zcode', options)
}
