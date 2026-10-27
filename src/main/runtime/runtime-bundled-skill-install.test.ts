import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { NAME, OLD_TEXT, NEW_TEXT } = vi.hoisted(() => ({
  NAME: 'test-skill',
  OLD_TEXT: '---\nname: test-skill\ndescription: Old\n---\n\nOld body\n',
  NEW_TEXT: '---\nname: test-skill\ndescription: New\n---\n\nNew body\n'
}))

vi.mock('../skills/bundled-skill-install/bundled-skill-sources', async () => {
  const { createHash } = await import('node:crypto')
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  return {
    BUNDLED_SKILL_SOURCES: [
      { name: NAME, text: NEW_TEXT, releasedDigests: [sha(OLD_TEXT), sha(NEW_TEXT)] }
    ]
  }
})
vi.mock('../preflight/installed-agent-detection', () => ({
  detectInstalledAgentsWithShellPathHydration: async () => ['claude', 'codex', 'cursor']
}))

import { localBundledSkillInput } from '../skills/bundled-skill-install/local-host'
import { previewBundledSkillInstall } from '../skills/bundled-skill-install/service'
import {
  readUserClaudeConfigDir,
  resolveClaudeDefaultHome
} from '../claude-accounts/claude-profile-paths'
import type { RuntimeSkillCommandHost } from './runtime-skill-command-contract'
import { planLocalBundledSkills } from './runtime-bundled-skill-install'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function homeWithClaudeCopy(claudeDir: (home: string) => string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-bundled-app-cli-')))
  roots.push(root)
  const home = join(root, 'home')
  const copy = join(claudeDir(home), 'skills', NAME)
  await mkdir(copy, { recursive: true })
  await writeFile(join(copy, 'SKILL.md'), OLD_TEXT)
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  return { home, userData: join(root, 'user-data') }
}

function appHost(home: string, userData: string): RuntimeSkillCommandHost {
  const host = {
    getRuntimeId: () => 'runtime-1',
    getUserDataPath: () => userData,
    skillTransactionRecovery: Promise.resolve(),
    // Why: the account router's host answer for System default.
    getClaudeConfigDirectory: () =>
      resolveClaudeDefaultHome(home, readUserClaudeConfigDir(process.env))
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: global-scope planning reads only these host members.
  return host as unknown as RuntimeSkillCommandHost
}

describe('app and CLI plan the same targets for one machine', () => {
  it.each([
    ['default ~/.claude', (home: string) => join(home, '.claude'), undefined],
    ['CLAUDE_CONFIG_DIR', (home: string) => join(home, 'claude-config'), 'claude-config']
  ])('%s', async (_label, claudeDir, configDirName) => {
    const { home, userData } = await homeWithClaudeCopy(claudeDir)
    if (configDirName) {
      vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, configDirName))
    }
    const app = await planLocalBundledSkills(appHost(home, userData), {})
    const cli = await previewBundledSkillInstall(
      await localBundledSkillInput({
        userDataPath: userData,
        destination: { scope: 'global', homeDirectory: home },
        selection: { installedOnly: true }
      })
    )
    expect(app.skills[0].ops.map((op) => [op.path, op.kind])).toEqual([
      [join(claudeDir(home), 'skills', NAME), 'update']
    ])
    expect(cli).toEqual(app)
  })
})

describe('named installs from setup screens', () => {
  it('plans an uninstalled skill only when the request names it', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-bundled-app-named-')))
    roots.push(root)
    const home = join(root, 'home')
    await mkdir(join(home, '.claude'), { recursive: true })
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    const host = appHost(home, join(root, 'user-data'))

    expect((await planLocalBundledSkills(host, {})).skills).toEqual([])
    const named = await planLocalBundledSkills(host, { names: [NAME] })
    expect(named.skills[0].ops.map((op) => [op.role, op.kind])).toEqual(
      expect.arrayContaining([
        ['shared', 'write'],
        ['agent', 'link']
      ])
    )
  })
})
