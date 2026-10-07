import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ home: '' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return { ...actual, homedir: () => state.home }
})

import { applyAgentWorkspaceTrust, type AgentTrustLaunchContext } from './agent-workspace-trust'
import { resolveOrcaManagedCodexHomePath } from './codex/codex-home-paths'

const USER_CONFIG = '# the user\'s own Codex config\nmodel = "o3"\n'

let root: string
let workspace: string
let previousUserDataPath: string | undefined

function userCodexConfig(): string {
  return join(state.home, '.codex', 'config.toml')
}

function mirrorConfig(): string {
  return join(resolveOrcaManagedCodexHomePath(), 'config.toml')
}

function trustedProjects(configFile: string): string[] {
  return [...readFileSync(configFile, 'utf-8').matchAll(/^\[projects\."(.*)"\]$/gm)].map((match) =>
    match[1].replaceAll('\\\\', '\\')
  )
}

function launchOn(codexHome: string | null): Promise<unknown> {
  const context: AgentTrustLaunchContext = {
    // Why HOME too: an explicit CODEX_HOME must leave this home's .codex alone; without one, trust goes there.
    env: { HOME: state.home, USERPROFILE: state.home },
    claudeAuth: null,
    wslDistro: null,
    connectionId: null,
    codexHome
  }
  return applyAgentWorkspaceTrust('codex', workspace, context)
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-codex-trust-home-')))
  state.home = join(root, 'home')
  workspace = join(root, 'projects', 'app')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(state.home, '.codex'), { recursive: true })
  writeFileSync(userCodexConfig(), USER_CONFIG)
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = join(root, 'user-data')
})

afterEach(() => {
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  rmSync(root, { recursive: true, force: true })
})

describe('local Codex trust follows the CODEX_HOME the launch runs on', () => {
  it("writes a per-account home and Orca's mirror, never the user's ~/.codex", async () => {
    const accountHome = join(root, 'user-data', 'codex-accounts', 'a', 'home')
    mkdirSync(accountHome, { recursive: true })

    await launchOn(accountHome)

    expect(trustedProjects(join(accountHome, 'config.toml'))).toEqual([workspace])
    expect(trustedProjects(mirrorConfig())).toEqual([workspace])
    expect(readFileSync(userCodexConfig(), 'utf-8')).toBe(USER_CONFIG)
  })

  it("writes only Orca's mirror when the launch runs on it", async () => {
    await launchOn(resolveOrcaManagedCodexHomePath())

    expect(trustedProjects(mirrorConfig())).toEqual([workspace])
    expect(readFileSync(userCodexConfig(), 'utf-8')).toBe(USER_CONFIG)
  })

  it('writes ~/.codex when the launch sets no CODEX_HOME, since that is the home Codex reads', async () => {
    rmSync(userCodexConfig())

    await launchOn(null)

    expect(trustedProjects(userCodexConfig())).toEqual([workspace])
    expect(trustedProjects(mirrorConfig())).toEqual([workspace])
  })

  it('creates no ~/.codex config for a launch on another home', async () => {
    rmSync(join(state.home, '.codex'), { recursive: true })
    const accountHome = join(root, 'accounts', 'b')
    mkdirSync(accountHome, { recursive: true })

    await launchOn(accountHome)

    expect(existsSync(join(state.home, '.codex'))).toBe(false)
    expect(trustedProjects(join(accountHome, 'config.toml'))).toEqual([workspace])
  })
})
