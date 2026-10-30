import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import {
  realClaudeAuthenticated,
  realClaudeAvailable,
  realClaudeCommand,
  realClaudeLaunchHome
} from './claude-real-cli-availability-test-support'
import { readClaudePromptParentUuid, resolveClaudeRewindFork } from './claude-rewind-fork'
import {
  CLAUDE_STRUCTURED_BASE_OPTIONS,
  type ClaudeStructuredSdkOptions
} from './claude-structured-launch-resolution'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import type { ClaudeStructuredSessionEvent } from './structured/claude-structured-session-state'
import { claudeStartupSettled } from './claude-structured-startup-settled-test-support'

const SESSION_ID = 'real-cli-rewind'

const identity = (providerSessionId: string): AgentSessionJournalIdentity => ({
  sessionId: SESSION_ID,
  workspaceId: 'real-cli-rewind-workspace',
  hostId: 'local',
  agent: 'claude',
  providerHandle: claudeProviderHandle(providerSessionId, null)
})

async function transcript(providerSessionId: string, claudeConfigDir: string): Promise<string> {
  const path = await resolveSessionFilePath('claude', providerSessionId, {
    claudeProjectsDir: join(claudeConfigDir, 'projects')
  })
  return readFile(path ?? '', 'utf8')
}

describe.skipIf(!realClaudeAvailable)('Claude structured real CLI rewind', () => {
  it.skipIf(!realClaudeAuthenticated)(
    'forks the conversation at the rewound prompt and forgets the undone turn',
    async () => {
      const source = randomUUID()
      const { claudeConfigDir, env } = realClaudeLaunchHome()
      const cwd = await mkdtemp(join(tmpdir(), 'orca-real-rewind-'))
      const results: string[] = []
      // Replay supplies transcript prompt IDs after dispatch resolves.
      const promptIds: string[] = []
      const adapterFor = (providerSessionId: string, launch: ClaudeStructuredSdkOptions) =>
        new ClaudeStructuredSessionAdapter({
          resolveLaunch: async () => ({
            pathToClaudeCodeExecutable: realClaudeCommand,
            options: { ...CLAUDE_STRUCTURED_BASE_OPTIONS, ...launch },
            cwd,
            env,
            claudeConfigDir,
            providerSessionId,
            resumeLeafUuid: null,
            resumesTranscript: false,
            cliFlag: async () => 'supported' as const,
            continuesChain: false
          }),
          onEvent: (event: ClaudeStructuredSessionEvent) => {
            if (event.type === 'message' && event.message.type === 'result') {
              results.push(String(event.message.result))
            }
          },
          onDispatchSettledLate: (settled) => {
            if ('providerIdentity' in settled && settled.providerIdentity.provider === 'claude') {
              promptIds.push(settled.providerIdentity.uuid)
            }
          },
          readProcessStartTime: async () => 1
        })
      const send = async (adapter: ClaudeStructuredSessionAdapter, text: string, n: number) => {
        await adapter.dispatch({
          sessionId: SESSION_ID,
          clientMessageId: `real-cli-rewind-${n}`,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
          requestedAt: Date.now(),
          fence: 1
        })
        await vi.waitFor(() => expect(results).toHaveLength(n), { timeout: 90_000, interval: 250 })
        return promptIds[n - 1]
      }

      const first = adapterFor(source, { sessionId: source })
      let promptUuid: string | undefined
      try {
        await first.acquire({ identity: identity(source), fence: 1, spawnToken: 'rewind-source' })
        await claudeStartupSettled(first, SESSION_ID)
        await send(first, 'Reply with the single word ALPHA and nothing else.', 1)
        promptUuid = await send(first, 'Reply with the single word BRAVO and nothing else.', 2)
      } finally {
        await first.closeAll()
      }

      const sourceBefore = await transcript(source, claudeConfigDir)
      expect(sourceBefore).toContain(`"uuid":"${promptUuid}"`)
      const throughEntryId = await readClaudePromptParentUuid({
        providerSessionId: source,
        promptUuid: promptUuid ?? '',
        claudeConfigDir
      })

      const fork = await resolveClaudeRewindFork({
        orcaSessionId: SESSION_ID,
        rewindOperationId: randomUUID(),
        head: claudeProviderHandle(source, null),
        prompt: { sessionId: source, uuid: promptUuid ?? '' },
        claudeConfigDirs: [claudeConfigDir]
      })
      expect(fork).toMatchObject({ materialized: true, throughEntryId })
      if (!fork) {
        throw new Error('rewind fork was not created')
      }
      const beforeSend = await transcript(fork.sessionId, claudeConfigDir)
      expect(beforeSend).toContain(throughEntryId)
      expect(beforeSend).not.toContain(promptUuid)
      const rewound = adapterFor(fork.sessionId, { resume: fork.sessionId })
      try {
        await rewound.acquire({
          identity: identity(fork.sessionId),
          fence: 1,
          spawnToken: 'rewind-fork'
        })
        await claudeStartupSettled(rewound, SESSION_ID)
        await send(
          rewound,
          'List every word I have asked you to reply with in this conversation, in capitals.',
          3
        )
      } finally {
        await rewound.closeAll()
      }

      const answer = results[2] ?? ''
      expect(answer).toContain('ALPHA')
      expect(answer).not.toContain('BRAVO')
      // Forked entries retain original UUIDs in provenance.
      const forked = await transcript(fork.sessionId, claudeConfigDir)
      expect(forked).toContain(`"messageUuid":"${throughEntryId}"`)
      expect(forked).not.toContain(promptUuid)
      expect(await transcript(source, claudeConfigDir)).toBe(sourceBefore)
    },
    240_000
  )
})
