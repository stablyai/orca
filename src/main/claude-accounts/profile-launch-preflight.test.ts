import type * as FsPromises from 'node:fs/promises'
// Real synthetic settings contents through provider preflight; only OS policy paths are relocated.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateManagedClaudeProfileLaunch } from './profile-launch-preflight'
import type { AgentProfileSnapshot } from '../../shared/agent-launch-profile'
import { gitExecFileAsync } from '../git/runner'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>()
  const map = (path: string) =>
    path.startsWith('/etc/claude-code')
      ? join(state.root, 'policy', path.slice('/etc/claude-code'.length))
      : path.startsWith('/Library/')
        ? join(state.root, 'mac-policy', path.slice('/Library/'.length))
        : path
  return {
    ...fs,
    lstat: (path: string) => fs.lstat(map(path)),
    readFile: (path: string, encoding: 'utf8') => fs.readFile(map(path), encoding),
    readdir: (path: string) => fs.readdir(map(path))
  }
})
let snapshot: AgentProfileSnapshot
let cwd: string
beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'claude-authority-'))
  cwd = join(state.root, 'workspace')
  const home = join(state.root, 'profile')
  for (const path of [
    cwd,
    home,
    join(cwd, '.claude'),
    join(state.root, 'policy', 'managed-settings.d')
  ]) {
    mkdirSync(path, { recursive: true })
  }
  snapshot = {
    id: 'a',
    name: 'A',
    agent: 'claude',
    hostId: 'local',
    executable: '/synthetic/claude',
    binding: { kind: 'managed', accountId: 'a' },
    resolvedHome: home,
    identity: { kind: 'verified', subject: 'a', displayName: 'a@example.invalid' }
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(state.root, { recursive: true, force: true })
})
function write(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value))
}
function validate() {
  return validateManagedClaudeProfileLaunch(snapshot, { cwd, env: {} })
}

it('retains benign user/project/local/policy settings', async () => {
  for (const path of [
    join(snapshot.resolvedHome, 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
    join(state.root, 'policy', 'managed-settings.json')
  ]) {
    write(path, {
      model: 'sonnet',
      permissions: { deny: ['Bash(rm *)'] },
      env: { NORMAL_SETTING: 'keep' }
    })
  }
  await expect(validate()).resolves.toBeUndefined()
})
it.each([
  ['user', { apiKeyHelper: 'echo synthetic' }],
  ['project', { env: { ANTHROPIC_API_KEY: 'synthetic' } }],
  ['local', { env: { CLAUDE_CONFIG_DIR: '/other' } }],
  ['policy', { env: { CLAUDE_CODE_USE_BEDROCK: '1' } }],
  ['drop-in', { env: { ANTHROPIC_BASE_URL: 'https://example.invalid' } }],
  ['policy', { policyHelper: { command: 'echo synthetic' } }],
  ['policy', { forceLoginMethod: 'console' }]
] as const)('refuses competing or unverifiable %s authority', async (source, value) => {
  const paths = {
    user: join(snapshot.resolvedHome, 'settings.json'),
    project: join(cwd, '.claude', 'settings.json'),
    local: join(cwd, '.claude', 'settings.local.json'),
    policy: join(state.root, 'policy', 'managed-settings.json'),
    'drop-in': join(state.root, 'policy', 'managed-settings.d', 'policy.json')
  }
  const path = paths[source]
  write(path, value)
  await expect(validate()).rejects.toThrow(/OAuth|policy/)
})
it('refuses cached remote policy and ignores all managed inspection for external homes', async () => {
  write(join(snapshot.resolvedHome, 'remote-settings.json'), {
    settings: { apiKeyHelper: 'echo synthetic' }
  })
  await expect(validate()).rejects.toThrow('policy')
  snapshot.binding = { kind: 'external', home: snapshot.resolvedHome }
  await expect(validate()).resolves.toBeUndefined()
})
it('refuses observable MDM without executing it', async () => {
  const root = join(state.root, 'mac-policy', 'Managed Preferences')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'com.anthropic.claudecode.plist'), 'synthetic policy')
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  await expect(validate()).rejects.toThrow('policy')
})
it.each(['settings.json', 'settings.local.json'])(
  'checks main checkout %s from a worktree subdirectory',
  async (filename) => {
    await gitExecFileAsync(['init'], { cwd })
    await gitExecFileAsync(
      [
        '-c',
        'user.name=Synthetic',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'fixture'
      ],
      { cwd }
    )
    const worktree = join(state.root, 'worktree')
    await gitExecFileAsync(['worktree', 'add', '-b', 'profile-fixture', worktree], { cwd })
    write(join(cwd, '.claude', filename), { apiKeyHelper: 'echo synthetic' })
    cwd = join(worktree, 'subdir')
    mkdirSync(cwd)
    await expect(validate()).rejects.toThrow('OAuth')
  }
)
it('refuses unreadable settings rather than assuming empty authority', async () => {
  writeFileSync(join(cwd, '.claude', 'settings.json'), '{ invalid')
  await expect(validate()).rejects.toThrow('policy')
})
