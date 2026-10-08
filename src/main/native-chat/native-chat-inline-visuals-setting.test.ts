import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { createClaudeStructuredLaunchResolver } from '../claude/claude-structured-launch-resolution'
import { CLAUDE_PLUGIN_DIR_FLAG, type ClaudeCliFlag } from '../claude/claude-cli-flag-support'
import { createCodexStructuredLaunchResolver } from '../codex/codex-structured-launch-resolution'
import {
  adapterFor,
  fakeCodex,
  identityFor
} from '../codex/codex-structured-session-adapter-fixture'
import { agentSessionRecordFixture } from './agent-session-record-test-fixture'
import {
  createNativeChatVisualsDelivery,
  NATIVE_CHAT_VISUALS_DIR_ENV
} from './native-chat-visuals-delivery'
import { nativeChatVisualsFolderFor } from './native-chat-visuals-folder'

const SKILL = { pluginDir: '/app/plugin', skillsRoot: '/app/plugin/skills' }
const MANUAL = { approvalPolicy: 'on-request', sandbox: 'workspace-write' } as const
const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function delivery(isEnabled: () => boolean) {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'orca-visuals-setting-'))
  scratch.push(stateDirectory)
  const prepareVisuals = createNativeChatVisualsDelivery({
    stateDirectory,
    logger: { warn: vi.fn(), error: vi.fn() },
    isEnabled,
    resolveSkill: async () => SKILL
  })
  return { stateDirectory, prepareVisuals }
}

describe('inline visuals launch preference', () => {
  it('starts Claude without visuals while preserving configured plugins, user folders and attachment access', async () => {
    const sessionId = 'claude-disabled'
    const { stateDirectory, prepareVisuals } = delivery(() => false)
    const supports = vi.fn(async (_flag: ClaudeCliFlag) => true)
    const record = agentSessionRecordFixture({ sessionId })
    const launch = await createClaudeStructuredLaunchResolver({
      store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
      resolveWorkspacePath: async () => '/repo',
      resolveCommand: () => '/bin/claude',
      resolveAuthPolicy: () => ({ stripAuthEnv: false }),
      resolveLaunchArgs: () => ['--add-dir', '/user/notes', '--plugin-dir', '/user/plugin'],
      resolveEnv: () => ({ [NATIVE_CHAT_VISUALS_DIR_ENV]: '/inherited', KEEP: 'yes' }),
      resolveInheritedEnv: async () => ({ PATH: '/bin' }),
      attachmentDirectory: '/state/agent-session-attachments',
      hasTranscript: async () => false,
      cliFlags: { supports },
      prepareVisuals
    })({ identity: { ...identityFor(sessionId), agent: 'claude', providerHandle: null } })
    expect(launch.options).not.toHaveProperty('plugins')
    expect(launch.options.extraArgs).toHaveProperty('plugin-dir', '/user/plugin')
    expect(launch.options.additionalDirectories).toEqual([
      '/user/notes',
      '/state/agent-session-attachments'
    ])
    expect(launch.env).not.toHaveProperty(NATIVE_CHAT_VISUALS_DIR_ENV)
    expect(launch.env?.KEEP).toBe('yes')
    expect(supports.mock.calls.map(([flag]) => flag)).not.toContain(CLAUDE_PLUGIN_DIR_FLAG)
    expect(existsSync(nativeChatVisualsFolderFor(stateDirectory, sessionId))).toBe(false)
  })

  it('gives new Codex chats the current preference without changing another live chat', async () => {
    let enabled = true
    const { stateDirectory, prepareVisuals } = delivery(() => enabled)
    const codex = fakeCodex({
      'config/read': () => ({
        config: { sandbox_workspace_write: { writable_roots: ['/user/notes'] } }
      })
    })
    const resolveLaunch = createCodexStructuredLaunchResolver({
      store: {
        getRecord: (sessionId) =>
          agentSessionRecordFixture({
            sessionId,
            provider: 'codex',
            accountHome: { variable: 'CODEX_HOME', path: '/home/codex' }
          }),
        pinLaunchDirectory: vi.fn()
      },
      resolveWorkspacePath: async () => '/repo',
      resolveCommand: () => '/bin/codex',
      resolveLaunchArgs: () => [],
      resolvePermissionPolicy: () => MANUAL,
      resolveEnvironment: async () => ({
        [NATIVE_CHAT_VISUALS_DIR_ENV]: '/inherited',
        KEEP: 'yes'
      }),
      prepareVisuals
    })
    const adapter = adapterFor(codex, {}, [], { resolveLaunch })
    const start = (sessionId: string) =>
      adapter.acquire({
        identity: {
          ...identityFor(sessionId),
          hostId: LOCAL_EXECUTION_HOST_ID,
          providerHandle: null
        },
        fence: 1,
        spawnToken: sessionId
      })
    try {
      await start('first')
      const first = codex.connections[0]!
      const firstCalls = [...first.calls]
      const firstFolder = nativeChatVisualsFolderFor(stateDirectory, 'first')
      expect(first.launch.env?.[NATIVE_CHAT_VISUALS_DIR_ENV]).toBe(firstFolder)
      expect(first.calls.find(({ method }) => method === 'thread/start')?.params).toMatchObject({
        config: { 'sandbox_workspace_write.writable_roots': ['/user/notes', firstFolder] }
      })

      enabled = false
      await start('disabled')
      const disabled = codex.connections[1]!
      expect(disabled.launch.env).not.toHaveProperty(NATIVE_CHAT_VISUALS_DIR_ENV)
      expect(disabled.launch.env?.KEEP).toBe('yes')
      expect(disabled.calls.map(({ method }) => method)).not.toContain('skills/extraRoots/set')
      const openIndex = disabled.calls.findIndex(({ method }) => method === 'thread/start')
      expect(disabled.calls.slice(0, openIndex).map(({ method }) => method)).not.toContain(
        'config/read'
      )
      expect(
        disabled.calls.find(({ method }) => method === 'thread/start')?.params
      ).not.toHaveProperty('config')
      expect(existsSync(nativeChatVisualsFolderFor(stateDirectory, 'disabled'))).toBe(false)
      expect(first.closed).toBe(false)
      expect(first.calls).toEqual(firstCalls)

      enabled = true
      await start('reenabled')
      const reenabled = codex.connections[2]!
      expect(
        reenabled.calls.find(({ method }) => method === 'skills/extraRoots/set')?.params
      ).toEqual({ extraRoots: [SKILL.skillsRoot] })
      expect(reenabled.launch.env?.[NATIVE_CHAT_VISUALS_DIR_ENV]).toBe(
        nativeChatVisualsFolderFor(stateDirectory, 'reenabled')
      )
      expect(first.closed).toBe(false)
      expect(first.calls).toEqual(firstCalls)
    } finally {
      await adapter.closeAll()
    }
  })
})
