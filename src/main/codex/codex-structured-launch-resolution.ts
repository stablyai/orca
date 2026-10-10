// How a durable session record becomes a Codex process launch.
//
// Every input is read back from the record the store already made durable, not
// from the call that triggered the acquire. A client that attaches twice must
// land in the same working directory under the same account home, and a resume
// must name the thread this session actually proved — never one a caller asks
// for, which is how a resume becomes a fork wearing a resume's name.

import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { resolveCodexCommand } from '../codex-cli/command'
import type {
  StructuredAgentLaunchBasis,
  StructuredAgentLaunchPart
} from '../runtime/structured-agent-launch-composition'
import type { CodexStructuredLaunch } from './codex-structured-session-adapter'
import type { CodexStructuredPermissionPolicy } from './codex-structured-permission-policy'
import { resolvePinnedCodexRolloutProof } from './codex-pinned-rollout-proof'
import { codexStructuredLaunchArgs } from './codex-structured-launch-args'
import {
  NATIVE_CHAT_VISUALS_DIR_ENV,
  withNativeChatVisualsEnv
} from '../native-chat/native-chat-visuals-delivery'

export type CodexStructuredLaunchPartDeps = {
  resolveLaunchArgs: () => Promise<string[]> | string[]
  /** Overridden in tests; production scans the boot-cached PATH and version-manager dirs. */
  resolveCommand?: (options?: { pathEnv?: string | null; homePath?: string }) => string
  resolveRollout?: typeof resolvePinnedCodexRolloutProof
  /** The user's Agent Permissions setting as thread policy, re-read per acquisition.
   *  States both postures outright — a resume inherits the last one for any field left absent. */
  resolvePermissionPolicy?: () => CodexStructuredPermissionPolicy
}

export type CodexStructuredInvocationDeps = Pick<
  CodexStructuredLaunchPartDeps,
  'resolveCommand'
> & {
  /** Fresh shell/configured environment for this spawn; never written to the session record. */
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
}

export type CodexStructuredInvocation = {
  command: string
  environment: NodeJS.ProcessEnv | undefined
}

/**
 * The one place a structured Codex child's binary and environment are
 * resolved. The session launch and the session-less catalog probe both build
 * on it, so a probe can never list under a different binary or env than the
 * session it stands in for. Env VALUES stay out of the catalog fingerprint:
 * drift there heals on the next refresh.
 */
export async function resolveCodexStructuredInvocation(
  deps: CodexStructuredInvocationDeps
): Promise<CodexStructuredInvocation> {
  const environment = await deps.resolveEnvironment?.()
  const pathEnv = environment?.PATH ?? environment?.Path ?? null
  const homePath = environment?.HOME ?? environment?.USERPROFILE
  const command = (deps.resolveCommand ?? resolveCodexCommand)({
    pathEnv,
    ...(homePath ? { homePath } : {})
  })
  return { command, environment }
}

/** Codex's part of a launch: its binary, thread arguments, account home, resume proof and visuals. */
export function codexStructuredLaunchPart(
  deps: CodexStructuredLaunchPartDeps
): (
  basis: StructuredAgentLaunchBasis
) => Promise<StructuredAgentLaunchPart<CodexStructuredLaunch>> {
  return async (basis) => {
    const { record } = basis
    const accountHome = requireLegacyAgentSessionAccountHome(record.accountHome)
    const { command } = await resolveCodexStructuredInvocation({
      ...(deps.resolveCommand ? { resolveCommand: deps.resolveCommand } : {}),
      resolveEnvironment: basis.environment
    })
    const environment = await basis.environment()
    const args = codexStructuredLaunchArgs(await deps.resolveLaunchArgs())
    const permissionPolicy = deps.resolvePermissionPolicy?.()
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    // A Codex record's chain holds only Codex handles; the launch admission refuses anything else.
    const resumeThreadId = head?.handle.nativeId ?? null
    // The same saved options every turn sends, so the thread and its turns name one model.
    const model = record.options?.model
    const visuals = await basis.visuals()
    // Before the rollout scan, so a missing floating folder is still the refusal that wins.
    await basis.launchDirectory()
    return {
      launch: {
        command,
        args: [...args, 'app-server'],
        codexHome: accountHome.path,
        // An empty chain is a session that has never proved a thread, so it
        // starts one; anything else resumes the last link this session proved.
        resumeThreadId,
        // Only a thread this session created may still be one Codex never saved: a resumed,
        // forked or adopted head names a conversation Codex held.
        ...(resumeThreadId && head?.origin === 'created' ? { supersedeIfUnsaved: true } : {}),
        ...(permissionPolicy ? { permissionPolicy } : {}),
        ...(model ? { model } : {}),
        ...(visuals ? { visuals } : {}),
        ...(resumeThreadId
          ? {
              resumePath: await (deps.resolveRollout ?? resolvePinnedCodexRolloutProof)(
                accountHome.path,
                resumeThreadId
              )
            }
          : {})
      },
      env: withNativeChatVisualsEnv(
        { ...environment, ...(accountHome.path ? { CODEX_HOME: accountHome.path } : {}) },
        visuals
      ),
      // Without visuals, a folder Orca itself inherited (started from a chat) names another chat's.
      inheritedEnvToDelete: visuals ? [] : [NATIVE_CHAT_VISUALS_DIR_ENV]
    }
  }
}
