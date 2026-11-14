import { createReadStream } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { requireLegacyAgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import {
  agentSessionProviderHandleChainHead,
  type AgentSessionProviderHandle
} from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import type { AgentSessionRewindFork } from '../../../shared/agent-session/lifecycle/rewind/agent-session-rewind'
import { getClaudeProfileRouter } from '../../claude-accounts/profiles/routing/claude-profile-installed-router'
import type { StructuredAgentSessionAdapter } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { resolveSessionFilePath } from '../../native-chat/session-file-resolver'
import { splitTranscriptStreamLines } from '../../native-chat/transcript-streaming/transcript-stream-lines'
import { claudeSessionIdForRewind } from '../structured/claude-structured-session-id'
import { materializeClaudeRewindTranscript } from './claude-rewind-transcript'

type TranscriptUserRow = {
  type: 'user'
  uuid: string
  parentUuid?: unknown
  isMeta?: unknown
  message?: unknown
}

const LOCAL_COMMAND_CAVEAT_OPEN = '<local-command-caveat>'

function isUserRow(value: unknown): value is TranscriptUserRow {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'user' &&
    'uuid' in value &&
    typeof value.uuid === 'string'
  )
}

export function isLocalCommandCaveatRow(row: Record<string, unknown>): boolean {
  return (
    row.isMeta === true &&
    typeof row.message === 'object' &&
    row.message !== null &&
    'content' in row.message &&
    typeof row.message.content === 'string' &&
    row.message.content.startsWith(LOCAL_COMMAND_CAVEAT_OPEN)
  )
}

/**
 * Rewind cuts at the prompt's parent, skipping a local command's caveat so the next prompt isn't
 * read as that command. Null for the first prompt, undefined if not found.
 */
export async function readClaudePromptParentUuid(input: {
  providerSessionId: string
  promptUuid: string
  claudeConfigDir: string
}): Promise<string | null | undefined> {
  const path = await resolveSessionFilePath('claude', input.providerSessionId, {
    claudeProjectsDir: join(input.claudeConfigDir, 'projects')
  })
  if (!path) {
    return undefined
  }
  // Claude appends a local command's caveat before the command row, so one pass sees it first.
  const caveatParents = new Map<string, string | null>()
  for await (const { line } of splitTranscriptStreamLines(createReadStream(path))) {
    const mayBeCaveat = line.includes(LOCAL_COMMAND_CAVEAT_OPEN)
    if (!mayBeCaveat && !line.includes(input.promptUuid)) {
      continue
    }
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!isUserRow(row)) {
      continue
    }
    const parent = typeof row.parentUuid === 'string' && row.parentUuid ? row.parentUuid : null
    if (row.uuid === input.promptUuid) {
      const caveatParent = parent ? caveatParents.get(parent) : undefined
      return caveatParent === undefined ? parent : caveatParent
    }
    if (mayBeCaveat && isLocalCommandCaveatRow(row)) {
      caveatParents.set(row.uuid, parent)
    }
  }
  return undefined
}

/** Search the prompt's source session so rewinds across earlier forks still find it. */
export async function resolveClaudeRewindFork(input: {
  orcaSessionId: string
  rewindOperationId: string
  head: AgentSessionProviderHandle
  prompt: { sessionId: string; uuid: string }
  claudeConfigDirs: readonly string[]
  destinationConfigDir?: string
}): Promise<AgentSessionRewindFork | null> {
  for (const claudeConfigDir of new Set(input.claudeConfigDirs)) {
    const parent = await readClaudePromptParentUuid({
      providerSessionId: input.prompt.sessionId,
      promptUuid: input.prompt.uuid,
      claudeConfigDir
    })
    if (parent !== undefined) {
      const fork = {
        sessionId: claudeSessionIdForRewind(input.orcaSessionId, input.rewindOperationId),
        sourceSessionId: input.prompt.sessionId,
        ...(parent ? { throughEntryId: parent } : {}),
        replacesSessionId: input.head.nativeId
      }
      const sourcePath = await resolveSessionFilePath('claude', input.prompt.sessionId, {
        claudeProjectsDir: join(claudeConfigDir, 'projects'),
        strictErrors: true
      })
      if (!sourcePath) {
        return null
      }
      return materializeClaudeRewindTranscript(
        sourcePath,
        fork,
        input.destinationConfigDir
          ? join(input.destinationConfigDir, 'projects', basename(dirname(sourcePath)))
          : undefined
      )
    }
  }
  return null
}

/** Search all known account homes because the chat's account may have changed. */
export const claudeForkForRewind: NonNullable<
  StructuredAgentSessionAdapter['forkForRewind']
> = async ({ record, beforeMessage, rewindOperationId }) => {
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)?.handle
  if (!head) {
    return { ok: false, reason: 'invalid-target' }
  }
  const router = getClaudeProfileRouter()
  const fork = await resolveClaudeRewindFork({
    orcaSessionId: record.sessionId,
    rewindOperationId,
    head,
    prompt: beforeMessage,
    destinationConfigDir: requireLegacyAgentSessionAccountHome(record.accountHome).path,
    claudeConfigDirs: [
      requireLegacyAgentSessionAccountHome(record.accountHome).path,
      ...(router ? [...router.accountHomes(), router.systemDefaultHome()] : [])
    ]
  })
  return fork ? { ok: true, fork } : { ok: false, reason: 'invalid-target' }
}
