import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { workspaceMayOverrideDefaultModel } from './agent-project-model-override'

let root: string

function write(path: string, content = ''): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

function mayOverride(
  agent: string,
  workspacePath: string,
  accountHomePath: string | null = '/homes/a'
) {
  return workspaceMayOverrideDefaultModel({ agent, workspacePath, accountHomePath })
}

describe('workspaceMayOverrideDefaultModel', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-project-model-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('finds a Codex project config at a linked worktree root', async () => {
    const worktree = join(root, 'wt')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    expect(await mayOverride('codex', worktree)).toBe(false)
    write(join(worktree, '.codex', 'config.toml'), 'model = "gpt-project"\n')
    expect(await mayOverride('codex', worktree)).toBe(true)
  })

  it('walks from a folder up to its repository root, and no further', async () => {
    const repo = join(root, 'repo')
    const folder = join(repo, 'packages', 'app')
    write(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(folder, { recursive: true })
    write(join(root, '.codex', 'config.toml'), 'model = "above-the-repo"\n')
    expect(await mayOverride('codex', folder)).toBe(false)
    write(join(repo, '.codex', 'config.toml'), 'model = "gpt-project"\n')
    expect(await mayOverride('codex', folder)).toBe(true)
  })

  it('reads only the folder itself when no repository contains it', async () => {
    const folder = join(root, 'loose')
    mkdirSync(folder, { recursive: true })
    write(join(root, '.codex', 'config.toml'), 'model = "parent"\n')
    expect(await mayOverride('codex', folder)).toBe(false)
  })

  it('skips the .codex directory that is the account home itself', async () => {
    const worktree = join(root, 'home-repo')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    write(join(worktree, '.codex', 'config.toml'), 'model = "user"\n')
    expect(await mayOverride('codex', worktree, join(worktree, '.codex'))).toBe(false)
  })

  it('finds a Claude project settings file, shared or local, but not the account home', async () => {
    const worktree = join(root, 'claude-repo')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    expect(await mayOverride('claude', worktree)).toBe(false)
    // The user's own `.claude` is account config, which the CLI's resolution already covers.
    write(join(worktree, '.claude', 'settings.json'), '{"model":"sonnet"}')
    expect(await mayOverride('claude', worktree, join(worktree, '.claude'))).toBe(false)
    expect(await mayOverride('claude', worktree)).toBe(true)
    rmSync(join(worktree, '.claude', 'settings.json'))
    write(join(worktree, '.claude', 'settings.local.json'), '{"effortLevel":"low"}')
    expect(await mayOverride('claude', worktree)).toBe(true)
  })

  it('ignores Claude project settings that pick no model or effort', async () => {
    const worktree = join(root, 'claude-permissions')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    // A committed permissions/hooks file, and the local file "always allow" writes.
    write(
      join(worktree, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(pnpm test)'] }, hooks: {}, env: { CI: '1' } })
    )
    write(
      join(worktree, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['WebFetch'] } })
    )
    expect(await mayOverride('claude', worktree)).toBe(false)
  })

  it.each([
    ['a model', { model: 'opus' }],
    ['a per-model effort', { modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } }],
    ['the model env var', { env: { ANTHROPIC_MODEL: 'claude-sonnet-5' } }],
    ['an alias target', { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5' } }],
    ['the effort env var', { env: { CLAUDE_CODE_EFFORT_LEVEL: 'low' } }],
    ['another provider', { env: { CLAUDE_CODE_USE_BEDROCK: '1' } }],
    ['an effort cap', { maxEffortLevel: 'medium' }],
    ['a main-thread agent', { agent: 'reviewer' }],
    ['Anthropic on AWS', { env: { CLAUDE_CODE_USE_ANTHROPIC_AWS: '1' } }],
    ['Anthropic on Google Cloud', { env: { CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '1' } }]
  ])('counts Claude project settings that set %s', async (_name, settings) => {
    const worktree = join(root, 'claude-model')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    write(join(worktree, '.claude', 'settings.json'), JSON.stringify(settings))
    expect(await mayOverride('claude', worktree)).toBe(true)
  })

  it('counts unreadable project config as an override', async () => {
    const worktree = join(root, 'broken')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    write(join(worktree, '.claude', 'settings.json'), '{ "model": ')
    write(join(worktree, '.codex', 'config.toml'), 'model = ')
    expect(await mayOverride('claude', worktree)).toBe(true)
    expect(await mayOverride('codex', worktree)).toBe(true)
  })

  it('ignores Codex project config that picks no model, effort or profile', async () => {
    const worktree = join(root, 'codex-mcp')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    write(join(worktree, '.codex', 'config.toml'), '[mcp_servers.docs]\ncommand = "docs-mcp"\n')
    expect(await mayOverride('codex', worktree)).toBe(false)
    write(
      join(worktree, '.codex', 'config.toml'),
      '[profiles.deep]\nmodel_reasoning_effort = "xhigh"\n'
    )
    expect(await mayOverride('codex', worktree)).toBe(true)
    write(join(worktree, '.codex', 'config.toml'), 'profile = "deep"\n')
    expect(await mayOverride('codex', worktree)).toBe(true)
  })

  it('never vouches for an agent whose project config it does not know', async () => {
    expect(await mayOverride('unknown-agent', join(root, 'anywhere'))).toBe(true)
  })

  it('ignores OpenCode project config that picks no model, effort or provider', async () => {
    const worktree = join(root, 'oc-plain')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    expect(await mayOverride('opencode', worktree, null)).toBe(false)
    // JSONC with comments, MCP servers, permissions and a subagent prompt.
    write(
      join(worktree, 'opencode.jsonc'),
      '{\n  // team MCP\n  "mcp": { "docs": { "type": "local" } },\n  "permission": { "edit": "ask" },\n  "agent": { "review": { "prompt": "be brief" } },\n}\n'
    )
    write(join(worktree, '.opencode', 'agent', 'review.md'), '---\ndescription: Reviews\n---\nBody')
    expect(await mayOverride('opencode', worktree, null)).toBe(false)
  })

  it.each([
    ['a model', 'opencode.json', { model: 'anthropic/claude-sonnet-5' }],
    ['a default agent', 'opencode.json', { default_agent: 'plan' }],
    ['an agent model', '.opencode/opencode.json', { agent: { build: { model: 'x/y' } } }],
    ['a 2.x agent variant', 'opencode.jsonc', { agents: { build: { variant: 'high' } } }],
    ['a mode model', 'opencode.json', { mode: { build: { model: 'x/y' } } }],
    ['its providers', 'opencode.json', { enabled_providers: ['openai'] }],
    ['a 2.x provider table', 'opencode.json', { providers: { openai: {} } }]
  ])('counts OpenCode project config that sets %s', async (_name, file, config) => {
    const worktree = join(root, 'oc-model')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    write(join(worktree, file), JSON.stringify(config))
    expect(await mayOverride('opencode', worktree, null)).toBe(true)
  })

  it('counts an OpenCode agent file whose frontmatter picks a model, and invalid JSONC', async () => {
    const worktree = join(root, 'oc-agent-file')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    write(join(worktree, '.opencode', 'agents', 'nested', 'build.md'), '---\nmodel: x/y\n---\n')
    expect(await mayOverride('opencode', worktree, null)).toBe(true)
    rmSync(join(worktree, '.opencode'), { recursive: true })
    write(join(worktree, 'opencode.json'), '{ "model": ')
    expect(await mayOverride('opencode', worktree, null)).toBe(true)
  })

  it('reads OpenCode config above the repository root too, as OpenCode 2.x does', async () => {
    const repo = join(root, 'oc-above', 'repo')
    write(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    write(join(root, 'oc-above', 'opencode.json'), '{"model":"x/y"}')
    expect(await mayOverride('opencode', repo, null)).toBe(true)
  })

  it.each([
    ['.omp/config.yml', 'modelRoles:\n  default: openai/gpt-6\n'],
    ['.omp/settings.json', '{"defaultThinkingLevel":"low"}'],
    ['.omp/settings.json', '{"enabledModels":["openai/*"]}'],
    ['.claude/settings.json', '{"modelRoles":{"default":"x/y"}}'],
    ['opencode.json', '{"modelProviderOrder":["openai"]}'],
    ['.codex/config.toml', 'defaultThinkingLevel = "low"\n'],
    ['.omp/config.yml', 'modelRoles: [\n']
  ])(
    'counts OMP project settings in %s that pick a model or thinking level',
    async (file, text) => {
      const worktree = join(root, 'omp-model')
      write(join(worktree, '.git'), 'gitdir: /elsewhere')
      write(join(worktree, file), text)
      expect(await mayOverride('omp', worktree, join(root, 'omp-home'))).toBe(true)
    }
  )

  it('ignores OMP project settings that pick no model', async () => {
    const worktree = join(root, 'omp-plain')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    write(join(worktree, '.omp', 'config.yml'), 'theme.dark: nord\n')
    write(join(worktree, '.claude', 'settings.json'), '{"model":"opus"}')
    write(join(worktree, 'opencode.json'), '{"mcp":{}}')
    expect(await mayOverride('omp', worktree, join(root, 'omp-home'))).toBe(false)
  })

  it.each([
    ['.pi/settings.json', '{"defaultProvider":"openai","defaultModel":"gpt-6"}'],
    ['.pi/settings.json', '{"defaultThinkingLevel":"low"}'],
    ['.pi/settings.json', '{"modelThinkingLevels":{"openai/gpt-6":"high"}}'],
    ['.pi/settings.json', '{"enabledModels":["openai/*"]}'],
    ['.pi/settings.json', '{"extensions":["./tools/pick-model.ts"]}'],
    ['.pi/settings.json', '{"packages":["npm:pi-model-router"]}'],
    ['.pi/settings.json', '{"defaultModel":'],
    ['.pi/extensions/pick-model.ts', 'export default () => {}\n']
  ])(
    'counts Pi project config in %s that may pick a model or thinking level',
    async (file, text) => {
      const worktree = join(root, 'pi-model')
      write(join(worktree, '.git'), 'gitdir: /elsewhere')
      write(join(worktree, file), text)
      expect(await mayOverride('pi', worktree, join(root, 'pi-home'))).toBe(true)
    }
  )

  it('ignores Pi project settings that pick no model, and the account home’s own settings', async () => {
    const worktree = join(root, 'pi-plain')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    expect(await mayOverride('pi', worktree, join(root, 'pi-home'))).toBe(false)
    write(join(worktree, '.pi', 'settings.json'), '\uFEFF{"theme":"dark","defaultTools":["+grep"]}')
    // Another agent's model settings are not Pi's.
    write(join(worktree, '.omp', 'settings.json'), '{"defaultModel":"gpt-6"}')
    expect(await mayOverride('pi', worktree, join(root, 'pi-home'))).toBe(false)
    write(join(worktree, '.pi', 'settings.json'), '{"defaultModel":"gpt-6"}')
    expect(await mayOverride('pi', worktree, join(worktree, '.pi'))).toBe(false)
  })

  it('ignores an empty Pi settings file and an extensions folder of only dotfiles', async () => {
    const worktree = join(root, 'pi-empty')
    write(join(worktree, '.git'), 'gitdir: /elsewhere')
    write(join(worktree, '.pi', 'settings.json'), '')
    write(join(worktree, '.pi', 'extensions', '.DS_Store'), 'x')
    write(join(worktree, '.pi', 'extensions', '.gitkeep'))
    expect(await mayOverride('pi', worktree, join(root, 'pi-home'))).toBe(false)
    write(join(worktree, '.pi', 'settings.json'), '\uFEFF  \n')
    expect(await mayOverride('pi', worktree, join(root, 'pi-home'))).toBe(false)
  })

  // Windows has no permission bits to make a folder unreadable.
  it.skipIf(process.platform === 'win32')(
    'counts a Pi extensions folder it cannot read',
    async () => {
      const worktree = join(root, 'pi-locked')
      write(join(worktree, '.git'), 'gitdir: /elsewhere')
      const extensions = join(worktree, '.pi', 'extensions')
      write(join(extensions, '.gitkeep'))
      expect(await mayOverride('pi', worktree, join(root, 'pi-home'))).toBe(false)
      // Unreadable, it might hold anything.
      chmodSync(extensions, 0o000)
      try {
        expect(await mayOverride('pi', worktree, join(root, 'pi-home'))).toBe(true)
      } finally {
        chmodSync(extensions, 0o755)
      }
    }
  )
})
