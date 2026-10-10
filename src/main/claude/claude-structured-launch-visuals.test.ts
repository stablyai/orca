import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  NATIVE_CHAT_VISUALS_DIR_ENV,
  type NativeChatVisualsLaunch
} from '../native-chat/native-chat-visuals-delivery'
import {
  CLAUDE_CLI_FLAG_PROBE_KILL_AFTER_MS,
  CLAUDE_PLUGIN_DIR_FLAG,
  type ClaudeCliFlag
} from './claude-cli-flag-support'
import { createClaudeStructuredLaunchResolver } from './claude-structured-launch-resolution'

const SESSION_ID = 'orca-session-visuals'
const VISUALS: NativeChatVisualsLaunch = {
  folder: '/state/native-chat-visuals/abc',
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

function launch(options: {
  prepareVisuals?: (sessionId: string) => Promise<NativeChatVisualsLaunch | null>
  supports?: (flag: ClaudeCliFlag, launch: unknown, budgetMs?: number) => Promise<boolean>
  launchArgs?: string[]
  env?: Record<string, string>
  attachmentDirectory?: string
}) {
  return createClaudeStructuredLaunchResolver({
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    resolveWorkspacePath: async (id) => `/repos/${id}`,
    resolveCommand: () => '/usr/local/bin/claude',
    resolveAuthPolicy: () => ({ account: 'system' }),
    resolveLaunchArgs: () => options.launchArgs ?? [],
    resolveEnv: () => options.env ?? {},
    hasTranscript: async () => false,
    ...(options.attachmentDirectory ? { attachmentDirectory: options.attachmentDirectory } : {}),
    ...(options.supports ? { cliFlags: { supports: options.supports } } : {}),
    ...(options.prepareVisuals ? { prepareVisuals: options.prepareVisuals } : {})
  })({ identity: IDENTITY })
}

describe('a Claude chat launch with inline visuals', () => {
  it('loads the skill plugin, grants the chat folder beside the user directories, and names it', async () => {
    const prepareVisuals = vi.fn(async () => VISUALS)
    const resolved = await launch({
      prepareVisuals,
      supports: async (flag) => flag === CLAUDE_PLUGIN_DIR_FLAG,
      launchArgs: ['--add-dir', '/shared/notes']
    })
    expect(prepareVisuals).toHaveBeenCalledWith(SESSION_ID)
    expect(resolved.options.plugins).toEqual([{ type: 'local', path: VISUALS.skill.pluginDir }])
    expect(resolved.options.additionalDirectories).toEqual(['/shared/notes', VISUALS.folder])
    expect(resolved.env?.[NATIVE_CHAT_VISUALS_DIR_ENV]).toBe(VISUALS.folder)
  })

  it.each([
    {
      name: 'prepared visuals',
      visuals: VISUALS,
      directories: ['/shared/notes', '/state/agent-session-attachments', VISUALS.folder]
    },
    {
      name: 'unavailable visuals',
      visuals: null,
      directories: ['/shared/notes', '/state/agent-session-attachments']
    }
  ])('keeps user folders and attachment access with $name', async ({ visuals, directories }) => {
    const resolved = await launch({
      prepareVisuals: async () => visuals,
      supports: async (flag) => flag === CLAUDE_PLUGIN_DIR_FLAG,
      launchArgs: ['--add-dir', '/shared/notes'],
      attachmentDirectory: '/state/agent-session-attachments'
    })
    expect(resolved.options.additionalDirectories).toEqual(directories)
  })

  it('still grants and names the folder when the CLI cannot load a plugin by path', async () => {
    const resolved = await launch({
      prepareVisuals: async () => VISUALS,
      supports: async () => false
    })
    expect(resolved.options).not.toHaveProperty('plugins')
    expect(resolved.options.additionalDirectories).toEqual([VISUALS.folder])
    expect(resolved.env?.[NATIVE_CHAT_VISUALS_DIR_ENV]).toBe(VISUALS.folder)
  })

  it('without a prepared folder, grants nothing and drops a folder inherited from another chat', async () => {
    const resolved = await launch({
      prepareVisuals: async () => null,
      supports: async () => true,
      env: { [NATIVE_CHAT_VISUALS_DIR_ENV]: '/state/native-chat-visuals/other-chat' }
    })
    expect(resolved.options).not.toHaveProperty('plugins')
    expect(resolved.options).not.toHaveProperty('additionalDirectories')
    expect(resolved.env).not.toHaveProperty(NATIVE_CHAT_VISUALS_DIR_ENV)
  })

  it('never asks about the plugin flag on a host that delivers no visuals', async () => {
    const supports = vi.fn(async (_flag: ClaudeCliFlag) => true)
    const resolved = await launch({ supports })
    expect(supports.mock.calls.map(([flag]) => flag)).not.toContain(CLAUDE_PLUGIN_DIR_FLAG)
    expect(resolved.options).not.toHaveProperty('plugins')
  })

  it('waits for the version up to the probe kill time for the plugin, never the short budget', async () => {
    const supports = vi.fn(
      async (_flag: ClaudeCliFlag, _launch: unknown, _budgetMs?: number) => true
    )
    await launch({ prepareVisuals: async () => VISUALS, supports })
    expect(supports).toHaveBeenCalledWith(
      CLAUDE_PLUGIN_DIR_FLAG,
      expect.objectContaining({ command: '/usr/local/bin/claude' }),
      CLAUDE_CLI_FLAG_PROBE_KILL_AFTER_MS
    )
  })

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

  it('never re-asks for thinking on a host without visuals', async () => {
    const supports = vi.fn(
      async (_flag: ClaudeCliFlag, _launch: unknown, _budgetMs?: number) => false
    )
    await launch({ supports })
    expect(supports).toHaveBeenCalledTimes(1)
  })
})
