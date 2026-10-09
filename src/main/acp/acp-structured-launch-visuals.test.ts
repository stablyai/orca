import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { NATIVE_CHAT_VISUALS_DIR_ENV } from '../native-chat/native-chat-visuals-delivery'
import { resolveProviderChildEnv } from '../provider-process/provider-process-launch'
import { acpLaunchSpecFor, type AcpLaunchSpec } from './acp-launch-specs'
import {
  createAcpStructuredLaunchResolver,
  type AcpStructuredLaunchResolverDeps
} from './acp-structured-launch-resolution'

const SKILL = { pluginDir: '/app/plugin', skillsRoot: '/app/plugin/skills' }
const FOLDER = '/state/native-chat-visuals/0123'
const identity = {
  sessionId: 'session-alpha-1',
  workspaceId: 'workspace-1',
  hostId: 'local',
  providerHandle: null
}

function record(spec: AcpLaunchSpec): AgentSessionRecord {
  const accountHome: AgentSessionRecord['accountHome'] =
    spec.agent === 'opencode'
      ? { kind: 'opencode', locator: { kind: 'unmanaged' } }
      : spec.agent === 'omp'
        ? { variable: 'PI_CODING_AGENT_DIR', path: '/home/user/.omp/agent' }
        : { variable: 'GROK_HOME', path: '/home/user/.grok' }
  return {
    ...agentSessionRecordFixture(),
    provider: spec.agent,
    providerHandleChain: [],
    accountHome
  }
}

function resolve(
  agent: string,
  options: {
    visuals?: boolean
    version?: string
    inheritedEnv?: NodeJS.ProcessEnv
    launchEnv?: Record<string, string>
    deps?: Partial<AcpStructuredLaunchResolverDeps>
    spec?: Partial<AcpLaunchSpec>
  } = {}
) {
  const spec = { ...acpLaunchSpecFor(agent)!, ...options.spec }
  const probeVersion = vi.fn<NonNullable<AcpStructuredLaunchResolverDeps['probeVersion']>>(
    async (_input, supports) => supports(options.version ?? '1.0.46')
  )
  const prepareVisuals = vi.fn(async () =>
    options.visuals === false ? null : { folder: FOLDER, skill: SKILL }
  )
  const logger = { warn: vi.fn(), error: vi.fn() }
  const launch = createAcpStructuredLaunchResolver(spec, {
    store: { getRecord: () => record(spec) },
    readJournal: () => null,
    resolveWorkspacePath: async () => '/repo/worktree',
    resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user' }),
    resolveLaunchEnv: () => options.launchEnv ?? {},
    resolveCommand: (command) => `/resolved/${command}`,
    inheritedEnv: options.inheritedEnv ?? {},
    probeVersion,
    prepareVisuals,
    logger,
    ...options.deps
  })({ identity: { ...identity, agent } })
  return { launch, probeVersion, prepareVisuals, logger }
}

describe('ACP launch visuals', () => {
  it("gives Grok the plugin folder and the chat's visuals folder", async () => {
    const launch = await resolve('grok').launch
    expect(launch.args).toEqual(['agent', '--plugin-dir', SKILL.pluginDir, 'stdio'])
    expect(launch.env[NATIVE_CHAT_VISUALS_DIR_ENV]).toBe(FOLDER)
    expect(launch.envToDelete).not.toContain(NATIVE_CHAT_VISUALS_DIR_ENV)
  })

  it('starts a Grok too old for --plugin-dir without visuals, never naming an inherited folder', async () => {
    const { launch, logger } = resolve('grok', {
      version: '1.0.10',
      inheritedEnv: { [NATIVE_CHAT_VISUALS_DIR_ENV]: '/another/chat' }
    })
    const resolved = await launch
    expect(resolved.args).toEqual(['agent', 'stdio'])
    expect(
      resolveProviderChildEnv(resolved, { [NATIVE_CHAT_VISUALS_DIR_ENV]: '/another/chat' })[
        NATIVE_CHAT_VISUALS_DIR_ENV
      ]
    ).toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('cannot load the visuals skill'),
      expect.objectContaining({ version: '1.0.10' })
    )
  })

  it('asks Grok for its version only when the chat has visuals', async () => {
    const { launch, probeVersion } = resolve('grok', { visuals: false })
    expect((await launch).args).toEqual(['agent', 'stdio'])
    expect(probeVersion).not.toHaveBeenCalled()
  })

  it("adds the skills root to OpenCode's inline config, keeping the user's own", async () => {
    const launch = await resolve('opencode', {
      version: '2.0.14',
      inheritedEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false }) }
    }).launch
    expect(launch.args).toEqual(['acp'])
    expect(JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT)).toEqual({
      autoupdate: false,
      skills: { paths: [SKILL.skillsRoot] }
    })
    expect(launch.env[NATIVE_CHAT_VISUALS_DIR_ENV]).toBe(FOLDER)
  })

  // OMP's settings layers (global, profile, project, overlays) replace lists, so any config of
  // Orca's would hide the user's own skill folders; a plugin folder adds beside them.
  it("gives OMP the plugin folder, leaving the user's config files as they set them", async () => {
    const launch = await resolve('omp', {
      version: '17.0.5',
      launchEnv: { PI_CONFIG_FILES: '/user/overlay.yml' }
    }).launch
    expect(launch.args).toEqual(['acp', '--plugin-dir', SKILL.pluginDir])
    expect(launch.env.PI_CONFIG_FILES).toBe('/user/overlay.yml')
    expect(launch.env[NATIVE_CHAT_VISUALS_DIR_ENV]).toBe(FOLDER)
  })

  it('still starts the chat when the skill cannot be prepared', async () => {
    const { launch, logger } = resolve('omp', {
      version: '17.0.5',
      spec: {
        visualsSkill: async () => {
          throw new Error('unreadable')
        }
      }
    })
    const resolved = await launch
    expect(resolved.args).toEqual(['acp'])
    expect(resolved.envToDelete).toContain(NATIVE_CHAT_VISUALS_DIR_ENV)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not be prepared'),
      expect.anything()
    )
  })

  it('still refuses a release the agent does not run structured chats on', async () => {
    await expect(resolve('omp', { version: '16.0.0' }).launch).rejects.toThrow()
  })
})
