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
import { linkGitWorktree, workspaceTrustWritten } from './workspace-trust-test-fixtures'

const state = vi.hoisted(() => ({ home: '' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return { ...actual, homedir: () => state.home }
})

import {
  AGENT_TRUST_INHERITS_FROM_A_HOME,
  applyWorkspaceTrustOnThisHost,
  type WorkspaceTrustHost
} from './execution-host-workspace-trust'

const PRESETS: readonly AgentTrustPreset[] = [
  'claude',
  'codex',
  'cursor',
  'copilot',
  'qoder',
  'antigravity'
]
// Why these three: each accepts trust from any ancestor folder, so trust on a home covers it all.
const INHERITING_PRESETS: readonly AgentTrustPreset[] = ['claude', 'copilot', 'qoder']
const EXACT_OR_SELF_LIMITING_PRESETS: readonly AgentTrustPreset[] = [
  'codex',
  'cursor',
  'antigravity'
]

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-host-trust-')))
  state.home = join(root, 'home', 'me')
  mkdirSync(state.home, { recursive: true })
  writeFileSync(join(state.home, '.claude.json'), '{}')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function thisHost(overrides: Partial<WorkspaceTrustHost> = {}): () => WorkspaceTrustHost {
  return () => ({
    homes: [state.home],
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
  it.each(PRESETS)('writes %s trust for an ordinary project folder', async (preset) => {
    const workspace = join(root, 'projects', 'app')
    mkdirSync(workspace, { recursive: true })
    await applyWorkspaceTrustOnThisHost(preset, workspace, thisHost())
    expect(trustWritten(preset)).toBe(true)
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
      // Why a missing segment: realpath fails there, and join() would collapse the `..` itself.
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
    it.each(INHERITING_PRESETS)('writes no %s trust', async (preset) => {
      const { workspace, homes } = arrange()
      await applyWorkspaceTrustOnThisHost(
        preset,
        workspace,
        thisHost(homes ? { homes } : undefined)
      )
      expect(trustWritten(preset)).toBe(false)
    })
  })

  it('guards exactly the agents that inherit trust from a home', () => {
    expect(PRESETS.filter((preset) => AGENT_TRUST_INHERITS_FROM_A_HOME[preset])).toEqual(
      INHERITING_PRESETS
    )
  })

  it.each(EXACT_OR_SELF_LIMITING_PRESETS)(
    'trusts a home folder workspace for %s, whose trust there covers only the home',
    async (preset) => {
      await applyWorkspaceTrustOnThisHost(preset, state.home, thisHost())
      expect(trustWritten(preset)).toBe(true)
    }
  )

  it('trusts a home folder workspace for Codex under the key Codex looks up', async () => {
    await applyWorkspaceTrustOnThisHost('codex', state.home, thisHost())
    expect(readFileSync(join(state.home, '.codex', 'config.toml'), 'utf-8')).toContain(
      `[projects."${state.home}"]`
    )
  })

  it.each(PRESETS)(
    'trusts a worktree whose main checkout is the home for %s, which stores the worktree path',
    async (preset) => {
      const worktree = join(root, 'worktrees', 'feature')
      linkGitWorktree(state.home, worktree)
      await applyWorkspaceTrustOnThisHost(preset, worktree, thisHost())
      expect(trustWritten(preset)).toBe(true)
    }
  )

  it("stores a Codex worktree's own path, not its main checkout", async () => {
    const worktree = join(root, 'worktrees', 'feature')
    linkGitWorktree(state.home, worktree)
    await applyWorkspaceTrustOnThisHost('codex', worktree, thisHost())
    const written = readFileSync(join(state.home, '.codex', 'config.toml'), 'utf-8')
    expect(written).toContain(`[projects."${worktree}"]`)
    expect(written).not.toContain(`[projects."${state.home}"]`)
  })

  it('trusts the exact subfolder Codex starts in, inside a folder that is not a repo', async () => {
    const subfolder = join(root, 'notes', 'sub')
    mkdirSync(subfolder, { recursive: true })
    await applyWorkspaceTrustOnThisHost('codex', subfolder, thisHost())
    expect(readFileSync(join(state.home, '.codex', 'config.toml'), 'utf-8')).toContain(
      `[projects."${subfolder}"]`
    )
  })

  it.each(INHERITING_PRESETS)('writes no %s trust when the host knows no home', async (preset) => {
    const workspace = join(root, 'projects', 'app')
    mkdirSync(workspace, { recursive: true })
    await applyWorkspaceTrustOnThisHost(
      preset,
      workspace,
      thisHost({ homes: [null, '', undefined] })
    )
    expect(trustWritten(preset)).toBe(false)
  })

  it('contains a host description or writer that throws, so the launch proceeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const workspace = join(root, 'projects', 'app')
    mkdirSync(workspace, { recursive: true })
    await expect(
      applyWorkspaceTrustOnThisHost('claude', workspace, () => {
        throw new Error('homedir unavailable')
      })
    ).resolves.toBeUndefined()
    await expect(
      applyWorkspaceTrustOnThisHost(
        'codex',
        workspace,
        thisHost({
          codexConfigFiles: () => {
            throw new Error('userData unavailable')
          }
        })
      )
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
