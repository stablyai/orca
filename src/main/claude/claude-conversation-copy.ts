import { AgentConversationCopyError } from '../native-chat/agent-conversation-copy-error'
import { isClaudeTranscriptRootPrompt } from './claude-transcript-root-prompt'
import { createReadStream } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session/lifecycle/agent-session-account-home'
import { getClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { splitTranscriptStreamLines } from '../native-chat/transcript-stream-lines'
import { readClaudePromptParentUuid } from './claude-rewind-fork'
import { materializeClaudeConversationTranscript } from './claude-rewind-transcript'
import { claudeSourceBlockId } from './claude-streamed-block-identity'
import { readClaudeTranscriptTail } from './claude-transcript-tail'
import { claudeRecord } from './structured/journal/claude-structured-item-translation'

function unavailable(): never {
  throw new AgentConversationCopyError(
    'Claude could not find this saved response. Wait for the response to finish, then try again.'
  )
}

export const copyClaudeConversation: NonNullable<
  StructuredAgentSessionAdapter['copyConversation']
> = async (input) => {
  const checkpoint = input.checkpoint
  if (!checkpoint?.throughMessage) {
    return unavailable()
  }
  const signal = AbortSignal.any([
    AbortSignal.timeout(60_000),
    ...(input.signal ? [input.signal] : [])
  ])
  const destinationHome = requireLegacyAgentSessionAccountHome(input.accountHome).path
  const router = getClaudeProfileRouter()
  const homes = new Set([
    destinationHome,
    ...(router ? [...router.accountHomes(), router.systemDefaultHome()] : [])
  ])
  const boundary = checkpoint.beforeMessage
  const sourceSessionId = boundary?.sessionId ?? checkpoint.throughMessage.sessionId
  for (const home of homes) {
    signal.throwIfAborted()
    const sourcePath = await resolveSessionFilePath(
      'claude',
      sourceSessionId,
      { claudeProjectsDir: join(home, 'projects'), strictErrors: true },
      signal
    )
    if (!sourcePath) {
      continue
    }
    let throughEntryId: string | undefined
    if (boundary) {
      throughEntryId =
        (await readClaudePromptParentUuid({
          providerSessionId: sourceSessionId,
          promptUuid: boundary.uuid,
          claudeConfigDir: home
        })) ?? undefined
    } else {
      let selectedUuid: string | undefined
      let duration = false
      for await (const { line } of splitTranscriptStreamLines(
        createReadStream(sourcePath, { signal })
      )) {
        let row: Record<string, unknown> | null
        try {
          row = claudeRecord(JSON.parse(line))
        } catch {
          continue
        }
        if (!row || row.isSidechain === true || row.parent_tool_use_id != null) {
          continue
        }
        const message = claudeRecord(row.message)
        if (
          row.uuid === checkpoint.throughMessage.uuid ||
          (typeof message?.id === 'string' &&
            typeof row.apiBlockIndex === 'number' &&
            claudeSourceBlockId(message.id, row.apiBlockIndex) === checkpoint.throughMessage.uuid)
        ) {
          selectedUuid = typeof row.uuid === 'string' ? row.uuid : undefined
          duration = false
        }
        if (selectedUuid && row.type === 'system' && row.subtype === 'turn_duration') {
          duration = true
        }
      }
      if (!selectedUuid) {
        return unavailable()
      }
      const tail = await readClaudeTranscriptTail({
        filePath: sourcePath,
        leafUuid: selectedUuid,
        check: () => signal.throwIfAborted()
      })
      if (!tail || (tail.rows.length > 0 && tail.rewound)) {
        return unavailable()
      }
      const nextRootIndex = tail.rows.findIndex(isClaudeTranscriptRootPrompt)
      const selectedTail = nextRootIndex === -1 ? tail.rows : tail.rows.slice(0, nextRootIndex)
      const endpoint = selectedTail.findLast(
        (row) => row.type === 'assistant' || row.type === 'user'
      )
      // No tail means the selected message itself is the main-branch leaf.
      let terminal = endpoint
      if (!terminal) {
        for await (const { line } of splitTranscriptStreamLines(
          createReadStream(sourcePath, { signal })
        )) {
          try {
            const row = claudeRecord(JSON.parse(line))
            if (row?.uuid === selectedUuid) {
              terminal = row
            }
          } catch {
            /* Torn line. */
          }
        }
      }
      const message = claudeRecord(terminal?.message)
      const stopped =
        !Array.isArray(message?.content) ||
        !message.content.some((part) => claudeRecord(part)?.type === 'tool_use')
      const terminalStop =
        stopped &&
        terminal?.type === 'assistant' &&
        ['end_turn', 'max_tokens', 'stop_sequence', 'refusal'].includes(
          String(message?.stop_reason)
        )
      if (!checkpoint.settled && !duration && !terminalStop && nextRootIndex === -1) {
        throw new AgentConversationCopyError(
          "Claude hasn't finished this response yet. Wait for it to finish, then try again."
        )
      }
      throughEntryId = typeof terminal?.uuid === 'string' ? terminal.uuid : selectedUuid
    }
    if (!throughEntryId) {
      return unavailable()
    }
    return (
      (await materializeClaudeConversationTranscript({
        sourcePath,
        sourceSessionId,
        throughEntryId,
        destinationDirectory: join(destinationHome, 'projects', basename(dirname(sourcePath))),
        title: input.title,
        signal
      })) ?? unavailable()
    )
  }
  return unavailable()
}
