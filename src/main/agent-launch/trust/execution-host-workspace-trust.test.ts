import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Os from 'node:os'
import type { AgentTrustPreset } from './agent-trust-presets'
import { workspaceTrustWritten } from './workspace-trust-test-fixtures'

const state = vi.hoisted(() => ({ home: '' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return { ...actual, homedir: () => state.home }
})

import {
  applyWorkspaceTrustOnThisHost,
  type WorkspaceTrustHost
} from './execution-host-workspace-trust'
const INHERITING_PRESETS: readonly AgentTrustPreset[] = ['claude', 'copilot', 'qoder']

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-host-trust-')))
  state.home = join(root, 'home', 'me')
  mkdirSync(state.home, { recursive: true })
  writeFileSync(join(state.home, '.claude.json'), '{}')
  // Trust grants record ownership under Orca's userData; keep it in the temp root.
  vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'user-data'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

function thisHost(overrides: Partial<WorkspaceTrustHost> = {}): () => WorkspaceTrustHost {
  return () => ({
    homes: [state.home],
    agentHome: state.home,
    claudeConfig: () => ({ configFile: join(state.home, '.claude.json'), keyStyle: 'posix' }),
    codexConfigFiles: () => [join(state.home, '.codex', 'config.toml')],
    deadlineMs: 1_500,
    ...overrides
  })
}

function trustWritten(preset: AgentTrustPreset): boolean {
  return workspaceTrustWritten(state.home, preset)
}

describe('applyWorkspaceTrustOnThisHost', () => {
  it('writes codewhale trust where its home and config overrides point', async () => {
    const workspace = join(root, 'projects', 'app')
    mkdirSync(workspace, { recursive: true })
    await applyWorkspaceTrustOnThisHost('codewhale', workspace, thisHost())
    expect(trustWritten('codewhale')).toBe(true)
    for (const codewhaleEnv of [
      { CODEWHALE_HOME: join(root, 'custom-home') },
      { CODEWHALE_CONFIG_PATH: join(root, 'custom-config.toml') },
      {
        CODEWHALE_HOME: join(root, 'ignored-home'),
        CODEWHALE_CONFIG_PATH: join(root, 'override.toml')
      },
      { CODEWHALE_CONFIG_PATH: '~/tilde-config.toml' }
    ]) {
      await applyWorkspaceTrustOnThisHost('codewhale', workspace, thisHost({ codewhaleEnv }))
      const file =
        codewhaleEnv.CODEWHALE_CONFIG_PATH?.replace(/^~\//, `${state.home}/`) ??
        join(codewhaleEnv.CODEWHALE_HOME!, 'config.toml')
      expect(readFileSync(file, 'utf-8')).toContain(`[projects."${workspace}"]`)
    }
  })

  const tooBroad: [string, () => { workspace: string; homes?: string[] }][] = [
    ['the home', () => ({ workspace: state.home })],
    ['a folder containing the home', () => ({ workspace: join(root, 'home') })],
    ['a filesystem root', () => ({ workspace: '/' })],
    [
      'a symlink to the home',
      () => {
        symlinkSync(state.home, join(root, 'home-link'), 'junction')
        return { workspace: join(root, 'home-link') }
      }
    ],
    [
      // Missing segments defeat realpath; preserve .. without join normalizing it away.
      'a missing path that resolves to the home through ..',
      () => ({ workspace: [state.home, 'missing', '..'].join(sep) })
    ],
    [
      'the home, when the host names it through a symlink',
      () => {
        symlinkSync(state.home, join(root, 'home-link'), 'junction')
        return { workspace: state.home, homes: [join(root, 'home-link')] }
      }
    ]
  ]
  describe.each(tooBroad)('for %s', (_label, arrange) => {
    it.each([...INHERITING_PRESETS, 'kimi'] as const)('writes no %s trust', async (preset) => {
      const { workspace, homes } = arrange()
      await applyWorkspaceTrustOnThisHost(
        preset,
        workspace,
        thisHost(homes ? { homes } : undefined)
      )
      expect(trustWritten(preset)).toBe(false)
    })
  })
})
