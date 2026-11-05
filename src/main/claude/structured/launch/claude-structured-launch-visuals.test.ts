import { createClaudeStructuredLaunchResolver } from '../../../runtime/structured-agent-launch-composition.test-support'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { NativeChatVisualsLaunch } from '../../../native-chat/native-chat-visuals-delivery'
import {
  CLAUDE_PLUGIN_DIR_FLAG,
  type ClaudeCliFlag,
  type ClaudeCliFlagFact
} from '../../claude-cli-flag-support'

const SESSION_ID = 'orca-session-visuals'
const VISUALS: NativeChatVisualsLaunch = {
  folder: '/state/chat-scratch/abc',
  skill: { pluginDir: '/app/native-chat-visuals', skillsRoot: '/app/native-chat-visuals/skills' }
}

const record = agentSessionRecordFixture({ sessionId: SESSION_ID })
const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: SESSION_ID,
  workspaceId: 'workspace-1',
  hostId: LOCAL_EXECUTION_HOST_ID,
  agent: 'claude',
  providerHandle: null
}

type Supports = (flag: ClaudeCliFlag, launch: unknown, budgetMs?: number) => Promise<boolean>

const checkOf =
  (supports: Supports) =>
  async (...args: Parameters<Supports>): Promise<ClaudeCliFlagFact> =>
    (await supports(...args)) ? 'supported' : 'unsupported'

function launch(options: {
  prepareVisuals?: (sessionId: string) => Promise<NativeChatVisualsLaunch | null>
  supports?: Supports
  launchArgs?: string[]
  env?: Record<string, string>
  attachmentDirectory?: string
}) {
  return createClaudeStructuredLaunchResolver({
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    resolveWorkspacePath: async (id) => `/repos/${id}`,
    resolveCommand: () => ({ command: '/usr/local/bin/claude', prefixArgs: [] }),
    resolveAuthPolicy: () => ({ account: 'system' }),
    resolveLaunchArgs: () => options.launchArgs ?? [],
    resolveEnv: () => options.env ?? {},
    hasTranscript: async () => false,
    ...(options.attachmentDirectory ? { attachmentDirectory: options.attachmentDirectory } : {}),
    ...(options.supports ? { cliFlags: { check: checkOf(options.supports) } } : {}),
    ...(options.prepareVisuals ? { prepareVisuals: options.prepareVisuals } : {})
  })({ identity: IDENTITY })
}

describe('a Claude chat launch with inline visuals', () => {
  it('asks for readable thinking again once the plugin check has learned the version', async () => {
    let versionKnown = false
    const supports = vi.fn(async (flag: ClaudeCliFlag, _launch: unknown, budgetMs?: number) => {
      if (flag === CLAUDE_PLUGIN_DIR_FLAG) {
        versionKnown = true
        return true
      }
      // The first thinking check gave up at its short budget; the re-check reads the cached answer.
      return versionKnown && budgetMs !== undefined
    })
    const resolved = await launch({ prepareVisuals: async () => VISUALS, supports })
    expect(resolved.options.plugins).toHaveLength(1)
    expect(resolved.options.extraArgs).toMatchObject({ 'thinking-display': 'summarized' })
  })
})
