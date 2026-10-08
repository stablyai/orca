// The real Claude CLI, launched through Orca's own launch resolution with a chat's visuals: the
// CLI must report the bundled skill and its plugin in its own init frame. Opt-in, like every
// real-CLI suite: it spends one short turn on the signed-in account.
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { createNativeChatVisualsDelivery } from '../native-chat/native-chat-visuals-delivery'
import { nativeChatVisualsFolderFor } from '../native-chat/native-chat-visuals-folder'
import { NATIVE_CHAT_VISUALS_SKILL_NAME } from '../native-chat/native-chat-visuals-skill-location'
import { createClaudeCliFlagSupport } from './claude-cli-flag-support'
import { readClaudeInit } from './claude-structured-init-proof'
import { createClaudeStructuredLaunchResolver } from './claude-structured-launch-resolution'
import {
  realClaudeAuthenticated,
  realClaudeAvailable,
  realClaudeCliGate,
  realClaudeCommand,
  realClaudeLaunchHome
} from './claude-real-cli-availability-test-support'
import {
  ClaudeStructuredSessionAdapter,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-adapter'

const SESSION_ID = 'real-cli-visuals'
const listed = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const suiteTitle = `Claude real CLI chat visuals${realClaudeCliGate.skipReason ? ` (skipped: ${realClaudeCliGate.skipReason})` : ''}`

describe.skipIf(!realClaudeAvailable)(suiteTitle, () => {
  it.skipIf(!realClaudeAuthenticated)(
    "loads the visuals skill through Orca's launch and grants the chat folder",
    async () => {
      const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
      const scratch = await mkdtemp(join(tmpdir(), 'orca-real-cli-visuals-'))
      const cwd = join(scratch, 'workspace')
      const stateDirectory = join(scratch, 'state')
      const record = agentSessionRecordFixture({
        sessionId: SESSION_ID,
        location: { workspaceId: 'real-cli-visuals-workspace' },
        accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: claudeConfigDir },
        launchDirectory: cwd
      })
      const logger = { warn: vi.fn(), error: vi.fn() }
      const resolveLaunch = createClaudeStructuredLaunchResolver({
        store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
        resolveWorkspacePath: async () => cwd,
        resolveCommand: () => realClaudeCommand,
        resolveEnv: () => realClaudeLaunchHome().env,
        resolveAuthPolicy: () => ({ stripAuthEnv: false }),
        hasTranscript: async () => false,
        cliFlags: createClaudeCliFlagSupport(),
        prepareVisuals: createNativeChatVisualsDelivery({ stateDirectory, logger })
      })
      const identity: AgentSessionJournalIdentity = {
        sessionId: SESSION_ID,
        workspaceId: 'real-cli-visuals-workspace',
        hostId: 'local',
        agent: 'claude',
        providerHandle: null
      }
      const events: ClaudeStructuredSessionEvent[] = []
      const adapter = new ClaudeStructuredSessionAdapter({
        resolveLaunch,
        onEvent: (event) => events.push(event),
        readProcessStartTime: async () => 1,
        now: () => 2
      })
      const frames = (): Record<string, unknown>[] =>
        events.flatMap((event) => (event.type === 'message' ? [event.message] : []))
      try {
        await mkdir(cwd, { recursive: true })
        const launch = await resolveLaunch({ identity })
        const folder = nativeChatVisualsFolderFor(stateDirectory, SESSION_ID)
        expect(launch.options.additionalDirectories).toEqual([folder])
        expect(launch.options.plugins).toHaveLength(1)
        await adapter.acquire({
          identity: {
            ...identity,
            providerHandle: claudeProviderHandle(launch.providerSessionId, null)
          },
          fence: 1,
          spawnToken: 'real-cli-visuals'
        })
        await adapter.dispatch({
          sessionId: SESSION_ID,
          clientMessageId: 'real-cli-visuals-1',
          body: {
            kind: 'message',
            role: 'user',
            blocks: [
              {
                type: 'text',
                text: 'Without using any tool, reply with only the exact names of the skills available to you whose name contains "visuals", comma separated, or NONE.'
              }
            ]
          },
          fence: 1
        })
        await vi.waitFor(
          () => expect(frames()).toContainEqual(expect.objectContaining({ type: 'result' })),
          { timeout: 120_000, interval: 200 }
        )
        const init = frames().find(
          (frame) => readClaudeInit(frame) !== null && frame.subtype === 'init'
        )
        // The model's own skill catalog lists it, though it is kept out of the `/` menu (and
        // so out of the init frame's skill and command lists).
        const answer = frames().find((frame) => frame.type === 'result')?.result
        expect(String(answer)).toContain(NATIVE_CHAT_VISUALS_SKILL_NAME)
        expect(
          [...listed(init?.skills), ...listed(init?.slash_commands)].some(
            (name) => typeof name === 'string' && name.endsWith(NATIVE_CHAT_VISUALS_SKILL_NAME)
          )
        ).toBe(false)
        expect(init?.plugins).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: launch.options.plugins?.[0]?.path })
          ])
        )
        expect(logger.warn).not.toHaveBeenCalled()
      } finally {
        await adapter.closeAll()
        await rm(scratch, { recursive: true, force: true })
      }
    },
    150_000
  )
})
