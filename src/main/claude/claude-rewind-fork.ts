import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import {
  agentSessionProviderHandleChainHead,
  type AgentSessionProviderHandle
} from '../../shared/agent-session-provider-handle'
import type { AgentSessionRewindFork } from '../../shared/agent-session-rewind'
import { getClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { splitTranscriptStreamLines } from '../native-chat/transcript-stream-lines'
import { claudeSessionIdForRewind } from './structured/claude-structured-session-id'
import { materializeClaudeRewindTranscript } from './claude-rewind-transcript'

type TranscriptPromptRow = { type: 'user'; uuid: string; parentUuid?: unknown }

function isPromptRow(value: unknown, promptUuid: string): value is TranscriptPromptRow {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'user' &&
    'uuid' in value &&
    value.uuid === promptUuid
  )
}

/** Rewind cuts at the prompt's parent: null for the first prompt, undefined if not found. */
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
  for await (const { line } of splitTranscriptStreamLines(createReadStream(path))) {
    if (!line.includes(input.promptUuid)) {
      continue
    }
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (isPromptRow(row, input.promptUuid)) {
      return typeof row.parentUuid === 'string' && row.parentUuid ? row.parentUuid : null
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
      return materializeClaudeRewindTranscript(sourcePath, fork)
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
    claudeConfigDirs: [
      requireLegacyAgentSessionAccountHome(record.accountHome).path,
      ...(router ? [...router.accountHomes(), router.systemDefaultHome()] : [])
    ]
  })
  return fork ? { ok: true, fork } : { ok: false, reason: 'invalid-target' }
}
