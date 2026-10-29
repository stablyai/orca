import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentChatPermissionChoice } from '../../shared/agent-chat-permission-mode'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import {
  CLAUDE_STRUCTURED_BASE_OPTIONS,
  claudeStructuredPermissionOptions
} from './claude-structured-launch-resolution'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import type { ClaudeStructuredSessionEvent } from './structured/claude-structured-session-state'
import {
  realClaudeAuthenticated,
  realClaudeAvailable,
  realClaudeCommand,
  realClaudeLaunchHome
} from './claude-real-cli-availability-test-support'
import { claudeStartupSettled } from './claude-structured-startup-settled-test-support'
import { journal } from './claude-context-usage-test-support'

const SESSION_ID = 'real-cli-live-permission'

async function launched(mode: AgentChatPermissionChoice) {
  const providerSessionId = randomUUID()
  const { claudeConfigDir, env } = realClaudeLaunchHome()
  const cwd = await mkdtemp(join(tmpdir(), 'orca-real-live-permission-'))
  const events: ClaudeStructuredSessionEvent[] = []
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => {
      const permission = claudeStructuredPermissionOptions(mode)
      return {
        pathToClaudeCodeExecutable: realClaudeCommand,
        options: {
          ...CLAUDE_STRUCTURED_BASE_OPTIONS,
          ...permission,
          extraArgs: { ...CLAUDE_STRUCTURED_BASE_OPTIONS.extraArgs, ...permission.extraArgs },
          sessionId: providerSessionId
        },
        cwd,
        env,
        claudeConfigDir,
        providerSessionId,
        resumeLeafUuid: null,
        resumesTranscript: false,
        cliFlag: async () => 'supported' as const,
        continuesChain: false
      }
    },
    onEvent: (event) => events.push(event),
    persistHandle: async () => {},
    readProcessStartTime: async () => 1
  })
  await adapter.acquire({
    identity: {
      sessionId: SESSION_ID,
      workspaceId: 'real-cli-live-permission-workspace',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle(providerSessionId, null)
    },
    fence: 1,
    spawnToken: 'real-cli-live-permission-1',
    permissionMode: mode,
    events: journal().sink
  })
  await claudeStartupSettled(adapter, SESSION_ID)
  const reported = async () =>
    (await adapter.readOptions({ sessionId: SESSION_ID, fence: 1 })).current.reportedPermissionMode
  const frames = () => events.flatMap((event) => (event.type === 'message' ? [event.message] : []))
  let turns = 0
  /** One short turn; resolves once its result frame arrives. */
  const turn = async () => {
    const seen = frames().filter((frame) => frame.type === 'result').length
    turns += 1
    await adapter.dispatch({
      sessionId: SESSION_ID,
      clientMessageId: `real-cli-live-permission-turn-${turns}`,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Reply with: OK' }] },
      requestedAt: 0,
      fence: 1
    })
    await vi.waitFor(
      () => expect(frames().filter((frame) => frame.type === 'result').length).toBe(seen + 1),
      { timeout: 60_000, interval: 200 }
    )
  }
  const inits = () =>
    frames().filter((frame) => frame.type === 'system' && frame.subtype === 'init')
  return {
    adapter,
    reported,
    turn,
    inits,
    close: async () => {
      await adapter.closeAll()
      await rm(cwd, { recursive: true, force: true })
    }
  }
}

// The real CLI answers a mode change with a status frame; allow it a slow machine's latency.
const REPORT_WAIT = { timeout: 15_000, interval: 200 }

describe.skipIf(!realClaudeAvailable)('Claude structured real CLI live permission switch', () => {
  it.skipIf(!realClaudeAuthenticated)(
    'switches an idle agent in place and reports the new mode, but not into Full access',
    async () => {
      const chat = await launched('ask')
      try {
        await expect(chat.adapter.applyPermissionMode(SESSION_ID, 'accept-edits')).resolves.toBe(
          true
        )
        await vi.waitFor(
          async () => expect(await chat.reported()).toBe('accept-edits'),
          REPORT_WAIT
        )
        await expect(chat.adapter.applyPermissionMode(SESSION_ID, 'full-access')).resolves.toBe(
          false
        )
        await expect(chat.adapter.applyPermissionMode(SESSION_ID, 'own')).resolves.toBe(false)
        expect(await chat.reported()).toBe('accept-edits')
      } finally {
        await chat.close()
      }
    },
    // Two real CLI launches and control round trips.
    90_000
  )

  it.skipIf(!realClaudeAuthenticated)(
    'switches an agent launched in Full access down and back up',
    async () => {
      const chat = await launched('full-access')
      try {
        await expect(chat.adapter.applyPermissionMode(SESSION_ID, 'ask')).resolves.toBe(true)
        await vi.waitFor(async () => expect(await chat.reported()).toBe('ask'), REPORT_WAIT)
        await expect(chat.adapter.applyPermissionMode(SESSION_ID, 'full-access')).resolves.toBe(
          true
        )
        await vi.waitFor(async () => expect(await chat.reported()).toBe('full-access'), REPORT_WAIT)
      } finally {
        await chat.close()
      }
    },
    // Two real CLI launches and control round trips.
    90_000
  )

  it.skipIf(!realClaudeAuthenticated)(
    'keeps a live switch through the next turn, so a model pick does not reopen the agent',
    async () => {
      const chat = await launched('full-access')
      try {
        await chat.turn()
        await expect(chat.adapter.applyPermissionMode(SESSION_ID, 'ask')).resolves.toBe(true)
        await chat.turn()
        // The CLI opens every turn with a root init that names the mode it now runs.
        expect(chat.inits().map((frame) => frame.permissionMode)).toEqual([
          'bypassPermissions',
          'default'
        ])
        expect(
          chat.adapter.requiresModelTransitionRestart({
            sessionId: SESSION_ID,
            fence: 1,
            executionOptions: { model: 'a-different-model' }
          })
        ).toBe(false)
      } finally {
        await chat.close()
      }
    },
    // Two real turns plus a launch.
    180_000
  )
})
