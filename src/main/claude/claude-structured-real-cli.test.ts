import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { resolveClaudeCommand } from '../codex-cli/command'
import { getSpawnArgsForWindows } from '../win32-utils'
import { CLAUDE_STRUCTURED_BASE_ARGS } from './claude-structured-launch-resolution'
import {
  ClaudeStructuredSessionAdapter,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-adapter'

const command = resolveClaudeCommand()
const versionLaunch = getSpawnArgsForWindows(command, ['--version'])
const realClaudeAvailable =
  spawnSync(versionLaunch.spawnCmd, versionLaunch.spawnArgs, {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 5_000
  }).status === 0

function realAdapter(
  providerSessionId: string,
  claudeConfigDir: string,
  events: ClaudeStructuredSessionEvent[] = []
): ClaudeStructuredSessionAdapter {
  const launch = getSpawnArgsForWindows(command, [
    ...CLAUDE_STRUCTURED_BASE_ARGS,
    '--session-id',
    providerSessionId
  ])
  return new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: launch.spawnCmd,
      args: launch.spawnArgs,
      cwd: process.cwd(),
      claudeConfigDir,
      providerSessionId,
      resumeLeafUuid: null,
      resumed: false
    }),
    onEvent: (event) => events.push(event),
    readProcessStartTime: async () => 1,
    now: () => 2,
    initTimeoutMs: 5_000
  })
}

function identity(providerSessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId: 'real-cli-handshake',
    workspaceId: 'real-cli-workspace',
    hostId: 'local',
    agent: 'claude',
    providerHandle: { kind: 'claude', sessionId: providerSessionId, leafUuid: null }
  }
}

describe.skipIf(!realClaudeAvailable)('Claude structured real CLI handshake', () => {
  it('proves a pre-minted session before the first user message', async () => {
    const providerSessionId = randomUUID()
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = realAdapter(providerSessionId, claudeConfigDir, events)

    try {
      const acquisition = await adapter.acquire({
        identity: identity(providerSessionId),
        fence: 1,
        spawnToken: 'real-cli'
      })
      const observedSubtypes = events.flatMap((event) =>
        event.type === 'message' ? [event.message.subtype] : []
      )

      expect(acquisition.link.handle).toMatchObject({
        provider: 'claude',
        sessionId: providerSessionId,
        leafUuid: expect.any(String)
      })
      expect(observedSubtypes).toContain('hook_started')
    } finally {
      await adapter.closeAll()
    }
  }, 10_000)

  it('turns a real silent unauthenticated startup into sign-in guidance', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'orca-claude-no-auth-'))
    const providerSessionId = randomUUID()
    const adapter = realAdapter(providerSessionId, claudeConfigDir)

    try {
      await expect(
        adapter.acquire({
          identity: identity(providerSessionId),
          fence: 1,
          spawnToken: 'real-cli-no-auth'
        })
      ).rejects.toThrow(/not signed in.*Claude CLI.*CLAUDE_CONFIG_DIR/s)
    } finally {
      await adapter.closeAll()
      await rm(claudeConfigDir, { recursive: true, force: true })
    }
  }, 10_000)
})
