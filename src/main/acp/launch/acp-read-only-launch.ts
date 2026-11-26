// Isolated read-only launch preparation and cleanup composition for ACP sessions.

import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import { agentSessionProviderHandleKey } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import {
  nothingExchangedOn,
  type SavedProviderTurnReads
} from '../../native-chat/agent-session-journal/journal-provider-turn-saved'
import type { AntigravityChatAuthConfig } from '../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import type { ReadOnlySessionMode } from '../../bots/bot-look-around-policy'
import type { StructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { acpAgentName } from '../session/acp-structured-agent-definitions'
import type { AcpLaunchSpec } from './acp-launch-contract'

export async function prepareAcpReadOnlyLaunch(input: {
  spec: AcpLaunchSpec
  readOnly: ReadOnlySessionMode | null
  dataDirectory: string
  env: Readonly<Record<string, string>>
  antigravityChatAuth?: AntigravityChatAuthConfig
  logger?: StructuredAgentSessionLogger
  onFailure?: () => Promise<void>
}): Promise<{ args: string[]; cwd?: string; release: () => Promise<void> } | null> {
  if (!input.readOnly) {
    return null
  }
  if (!input.spec.prepareReadOnlyLaunch) {
    await input.onFailure?.().catch(() => undefined)
    throw new Error(`${acpAgentName(input.spec.agent)} does not support ${input.readOnly} sessions`)
  }
  try {
    return await input.spec.prepareReadOnlyLaunch({
      mode: input.readOnly,
      dataDirectory: input.dataDirectory,
      env: input.env,
      ...(input.antigravityChatAuth ? { antigravityChatAuth: input.antigravityChatAuth } : {}),
      ...(input.logger ? { logger: input.logger } : {})
    })
  } catch (error) {
    await input.onFailure?.().catch(() => undefined)
    throw error
  }
}

export async function resolveAcpLaunchArgsAndRelease(input: {
  spec: AcpLaunchSpec
  readOnly: ReadOnlySessionMode | null
  fullAccess: boolean
  pluginDirs: readonly string[]
  model?: string
  skillArgs?: readonly string[]
  instructionArgs?: readonly string[]
  instructionRelease?: () => Promise<void>
  dataDirectory: string
  env: Readonly<Record<string, string>>
  antigravityChatAuth?: AntigravityChatAuthConfig
  logger?: StructuredAgentSessionLogger
}): Promise<{ args: string[]; cwd?: string; release?: () => Promise<void> }> {
  const readOnlyLaunch = await prepareAcpReadOnlyLaunch({
    spec: input.spec,
    readOnly: input.readOnly,
    dataDirectory: input.dataDirectory,
    env: input.env,
    antigravityChatAuth: input.antigravityChatAuth,
    logger: input.logger,
    onFailure: input.instructionRelease
  })
  const baseArgs =
    readOnlyLaunch?.args ??
    input.spec.args({
      fullAccess: input.fullAccess,
      pluginDirs: input.pluginDirs,
      model: input.model
    })
  return {
    args: [...baseArgs, ...(input.skillArgs ?? []), ...(input.instructionArgs ?? [])],
    ...(readOnlyLaunch?.cwd ? { cwd: readOnlyLaunch.cwd } : {}),
    release: composeAcpReleases(input.instructionRelease, readOnlyLaunch?.release)
  }
}

export function composeAcpReleases(
  ...releases: readonly ((() => Promise<void>) | undefined)[]
): (() => Promise<void>) | undefined {
  const fns = releases.filter((entry): entry is () => Promise<void> => entry !== undefined)
  if (fns.length === 0) {
    return undefined
  }
  return async () => {
    await Promise.allSettled(fns.map((fn) => fn()))
  }
}

/** Resume metadata for an ACP session whose durable record holds a previous provider handle. */
export function acpLaunchResumeInfo(
  record: Pick<AgentSessionRecord, 'providerHandleChain'>,
  sessionId: string,
  savedSession: SavedProviderTurnReads
) {
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
  if (!head) {
    return null
  }
  return {
    sessionId: head.handle.nativeId,
    key: agentSessionProviderHandleKey(head.handle),
    mayBeUnsaved: async () =>
      head.origin === 'created' &&
      (await nothingExchangedOn(savedSession, sessionId, head.handle.nativeId)),
    lossKeys: record.providerHandleChain.flatMap((link) =>
      link.replaces?.reason === 'restore-failed' ? [link.replaces.key] : []
    )
  }
}
