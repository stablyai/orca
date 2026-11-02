import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { detectMock } = vi.hoisted(() => ({ detectMock: vi.fn() }))
vi.mock('../../preflight/installed-agent-detection', () => ({
  detectInstalledAgentsWithShellPathHydration: detectMock
}))

import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_USER_CONFIG_DIR_ENV
} from '../../../shared/claude-profile-routing'
import { localBundledSkillInput } from './local-host'

const HOME = resolve('/', 'home', 'u')
const USER_DATA = resolve('/', 'data', 'orca')

afterEach(() => {
  detectMock.mockReset()
  vi.unstubAllEnvs()
})

describe('localBundledSkillInput', () => {
  it('uses explicit agents without detecting, and the cloud-install state directory', async () => {
    const input = await localBundledSkillInput({
      userDataPath: USER_DATA,
      destination: { scope: 'global', homeDirectory: HOME },
      agents: [],
      claudeConfigDirectory: join(HOME, '.claude'),
      selection: { names: ['orca-cli'], force: 'all', installedOnly: true }
    })
    expect(detectMock).not.toHaveBeenCalled()
    expect(input).toMatchObject({
      destination: { scope: 'global', homeDirectory: HOME },
      agents: [],
      providerRootOverrides: { claude: join(HOME, '.claude', 'skills') },
      stateDirectory: join(USER_DATA, 'skill-installs'),
      names: ['orca-cli'],
      force: 'all',
      installedOnly: true
    })
  })

  it('detects agents when none are given and keeps only ones Orca can place a skill for', async () => {
    detectMock.mockResolvedValue(['claude', 'aider', 'codex'])
    const input = await localBundledSkillInput({
      userDataPath: USER_DATA,
      destination: { scope: 'global', homeDirectory: HOME },
      selection: {}
    })
    expect(input.agents).toEqual(['claude', 'codex'])
    expect(input).not.toHaveProperty('force')
    expect(input).not.toHaveProperty('installedOnly')
  })

  it('reads provider homes from the environment for global scope only', async () => {
    const claudeHome = join(HOME, 'custom-claude')
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome)
    const global = await localBundledSkillInput({
      userDataPath: USER_DATA,
      destination: { scope: 'global', homeDirectory: HOME },
      agents: ['claude'],
      selection: {}
    })
    expect(global.providerRootOverrides).toMatchObject({ claude: join(claudeHome, 'skills') })

    const workspace = await localBundledSkillInput({
      userDataPath: USER_DATA,
      destination: {
        scope: 'workspace',
        homeDirectory: HOME,
        workspaceDirectory: join(HOME, 'repo')
      },
      agents: ['claude'],
      selection: {}
    })
    expect(workspace.providerRootOverrides).toEqual({})
  })

  it("reads past a CLAUDE_CONFIG_DIR Orca injected, as the app's account router does", async () => {
    const injected = join(USER_DATA, 'claude-profiles', 'work')
    vi.stubEnv('CLAUDE_CONFIG_DIR', injected)
    vi.stubEnv(CLAUDE_INJECTED_CONFIG_DIR_ENV, injected)
    vi.stubEnv(CLAUDE_USER_CONFIG_DIR_ENV, '')
    const input = await localBundledSkillInput({
      userDataPath: USER_DATA,
      destination: { scope: 'global', homeDirectory: HOME },
      agents: ['claude'],
      selection: {}
    })
    expect(input.providerRootOverrides).toMatchObject({
      claude: join(HOME, '.claude', 'skills')
    })
  })
})
