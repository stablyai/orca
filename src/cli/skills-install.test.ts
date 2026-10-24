import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BundledSkillInstallResult, BundledSkillPlan } from '../shared/bundled-skill-plan'

const NAME = 'orca-cli'
const OLD_TEXT = `---\nname: ${NAME}\ndescription: Old\n---\n\nOld body\n`
const NEW_TEXT = `---\nname: ${NAME}\ndescription: New\n---\n\nNew body\n`
const EDITED_TEXT = `---\nname: ${NAME}\n---\nmine\n`
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

const { detectAgentsMock } = vi.hoisted(() => ({ detectAgentsMock: vi.fn() }))

// Use the real installer in a temporary home; pin bundled bytes and agent detection for portability.
vi.mock('../main/skills/bundled-skill-install/bundled-skill-sources', () => ({
  BUNDLED_SKILL_SOURCES: [
    { name: NAME, text: NEW_TEXT, releasedDigests: [sha(OLD_TEXT), sha(NEW_TEXT)] }
  ]
}))
vi.mock('../main/preflight/installed-agent-detection', () => ({
  detectInstalledAgentsWithShellPathHydration: detectAgentsMock
}))
// Avoid the production five-second lock wait in tests.
vi.mock('../main/skills/bundled-skill-install/local-host', async (importOriginal) => {
  const actual = await importOriginal<typeof LocalHost>()
  return {
    localBundledSkillInput: async (...args: Parameters<typeof actual.localBundledSkillInput>) => ({
      ...(await actual.localBundledSkillInput(...args)),
      lockTimeoutMs: 50
    })
  }
})

import type * as LocalHost from '../main/skills/bundled-skill-install/local-host'
import { main } from './index'
import { acquireSkillInstallLock, skillInstallLockPath } from '../main/skills/skill-install-lock'

type Paths = { root: string; home: string; userData: string; shared: string; claude: string }

let paths: Paths

async function makeHome(): Promise<Paths> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-cli-skills-')))
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  return {
    root,
    home,
    userData: join(root, 'user-data'),
    shared: join(home, '.agents', 'skills', NAME),
    claude: join(home, '.claude', 'skills', NAME)
  }
}

async function writeCopy(path: string, text: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'SKILL.md'), text)
}

async function skillText(path: string): Promise<string | null> {
  return readFile(join(path, 'SKILL.md'), 'utf8').catch(() => null)
}

async function run(args: string[]): Promise<string> {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    await main(['skills', ...args], paths.root)
    return stdout.mock.calls.map((call) => String(call[0])).join('')
  } finally {
    stdout.mockRestore()
  }
}

async function runJson<T>(args: string[]): Promise<T> {
  const parsed: T = JSON.parse(await run([...args, '--json']))
  return parsed
}

type DryRunJson = {
  executed: false
  planDigest: string
  plan: BundledSkillPlan
  notInstalled: string[]
}
type RunJson = {
  executed: true
  planDigest: string
  plan: BundledSkillPlan
  result: BundledSkillInstallResult
  summary: { ok: boolean; exitCode: number; skills: { line: string }[] }
  notInstalled: string[]
}

describe('orca skills install/update', () => {
  beforeEach(async () => {
    paths = await makeHome()
    vi.stubEnv('HOME', paths.home)
    vi.stubEnv('USERPROFILE', paths.home)
    vi.stubEnv('ORCA_USER_DATA_PATH', paths.userData)
    vi.stubEnv('CLAUDE_CONFIG_DIR', '')
    vi.stubEnv('OPENCLAUDE_CONFIG_DIR', '')
    vi.stubEnv('ORCA_CLI_CWD', '')
    detectAgentsMock.mockReset()
    detectAgentsMock.mockResolvedValue(['claude'])
    process.exitCode = undefined
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    process.exitCode = undefined
    await rm(paths.root, { recursive: true, force: true })
  })

  it('prints the plan and its digest for --dry-run and writes nothing', async () => {
    await writeCopy(paths.shared, OLD_TEXT)

    const text = await run(['update', '--skill', NAME, '--agent', 'claude', '--dry-run'])

    // Updating must not install skills for an agent that lacks them.
    expect(text).toContain(`${NAME}\n  ${paths.shared}: Update\n\n`)
    expect(text).toMatch(/Plan digest: [0-9a-f]{64}\nRerun without --dry-run to update now\.\n$/u)
    expect(await skillText(paths.shared)).toBe(OLD_TEXT)
    expect(await lstat(paths.claude).catch(() => null)).toBeNull()
    expect(process.exitCode).toBeUndefined()
  })

  it('executes exactly the ops the dry run printed', async () => {
    await writeCopy(paths.shared, OLD_TEXT)
    const args = ['install', '--skill', NAME, '--agent', 'claude']

    const dry = await runJson<DryRunJson>([...args, '--dry-run'])
    const real = await runJson<RunJson>(args)

    expect(dry.executed).toBe(false)
    expect(real.planDigest).toBe(dry.planDigest)
    expect(real.result.skills.map((skill) => skill.ops.map((op) => [op.path, op.kind]))).toEqual(
      dry.plan.skills.map((skill) => skill.ops.map((op) => [op.path, op.kind]))
    )
    expect(real.result.skills[0].ops.every((op) => op.status === 'done')).toBe(true)
    expect(real.summary).toMatchObject({ ok: true, exitCode: 0 })
    expect(await skillText(paths.shared)).toBe(NEW_TEXT)
    expect(await realpath(paths.claude)).toBe(paths.shared)
    expect(process.exitCode).toBe(0)
  })

  it('prints one result line per skill for a real run', async () => {
    await writeCopy(paths.shared, OLD_TEXT)

    const text = await run(['update', '--skill', NAME, '--agent', 'universal'])

    expect(text).toBe(`${NAME}: Updated\n`)
  })

  it('never installs a skill on update; install adds it', async () => {
    const text = await run(['update', '--skill', NAME, '--agent', 'claude'])

    expect(text).toContain(`${NAME}: not installed, so skipped.`)
    expect(await lstat(paths.shared).catch(() => null)).toBeNull()

    await run(['install', '--skill', NAME, '--agent', 'claude'])
    expect(await skillText(paths.shared)).toBe(NEW_TEXT)
    expect(await realpath(paths.claude)).toBe(paths.shared)
  })

  it('leaves an edited copy alone, then replaces it with a backup for --force', async () => {
    await writeCopy(paths.shared, EDITED_TEXT)

    const left = await run(['update', '--skill', NAME, '--agent', 'universal'])
    expect(left).toContain('Update skipped: Skill edited outside Orca')
    expect(left).toContain('1 skipped: Skill edited outside Orca')
    expect(left).toContain('Rerun with --force to replace a copy that was skipped')
    expect(left).not.toContain('left alone')
    expect(process.exitCode).toBe(0)
    expect(await skillText(paths.shared)).toBe(EDITED_TEXT)

    const forced = await runJson<RunJson>([
      'update',
      '--skill',
      NAME,
      '--agent',
      'universal',
      '--force'
    ])
    expect(forced.plan.skills[0].ops.map((op) => op.kind)).toEqual(['replace'])
    expect(await skillText(paths.shared)).toBe(NEW_TEXT)
    const backupPath = forced.result.skills[0].ops[0].backupPath ?? ''
    expect(backupPath.startsWith(join(paths.home, '.agents', '.orca-skill-backups'))).toBe(true)
    expect(await skillText(backupPath)).toBe(EDITED_TEXT)
  })

  it('exits 1 when the run cannot apply the plan', async () => {
    await writeCopy(paths.shared, OLD_TEXT)
    const release = await acquireSkillInstallLock({
      path: skillInstallLockPath(join(paths.userData, 'skill-installs'), paths.shared)
    })
    try {
      const real = await runJson<RunJson>(['update', '--skill', NAME, '--agent', 'universal'])
      expect(real.result.skills[0].status).toBe('busy')
      expect(real.summary).toMatchObject({ ok: false, exitCode: 1 })
    } finally {
      await release()
    }
    expect(process.exitCode).toBe(1)
    expect(await skillText(paths.shared)).toBe(OLD_TEXT)
  }, 20_000)

  it('counts a skill with multiple skipped folders once in text and JSON summaries', async () => {
    await writeCopy(paths.shared, EDITED_TEXT)
    await writeCopy(paths.claude, EDITED_TEXT)

    const args = ['update', '--skill', NAME, '--agent', 'claude']
    const text = await run(args)
    expect(text).toContain(`${NAME}: No change · 1 skipped: Skill edited outside Orca\n`)
    expect(text).toContain(`  ${paths.shared}: Update skipped: Skill edited outside Orca`)
    expect(text).toContain(`  ${paths.claude}: Update skipped: Skill edited outside Orca`)
    const result = await runJson<RunJson>(args)
    expect(result.summary).toMatchObject({ ok: true, changedCount: 0, leftAloneCount: 1 })
  })

  it("accepts the skills CLI's agent keys and universal for the shared folder alone", async () => {
    await writeCopy(paths.shared, NEW_TEXT)

    const aliased = await runJson<DryRunJson>([
      'install',
      '--skill',
      NAME,
      '--agent',
      'claude-code',
      '--dry-run'
    ])
    expect(aliased.plan.skills[0].ops.map((op) => [op.path, op.kind])).toEqual([
      [paths.shared, 'keep'],
      [paths.claude, 'link']
    ])
    const shared = await runJson<DryRunJson>([
      'install',
      '--skill',
      NAME,
      '--agent',
      'universal',
      '--dry-run'
    ])
    expect(shared.plan.skills[0].ops.map((op) => op.path)).toEqual([paths.shared])
    expect(detectAgentsMock).not.toHaveBeenCalled()
  })

  it('installs for OpenClaude when its Orca agent id is requested directly', async () => {
    await run(['install', '--skill', NAME, '--agent', 'openclaude'])

    expect(await realpath(join(paths.home, '.openclaude', 'skills', NAME))).toBe(paths.shared)
    expect(await skillText(paths.shared)).toBe(NEW_TEXT)
    expect(await lstat(paths.claude).catch(() => null)).toBeNull()
    expect(process.exitCode).toBe(0)
  })

  it.each([
    ['claude-code', '.claude', '.openclaude'],
    ['openclaude', '.openclaude', '.claude']
  ])('updates an existing agent-only copy for --agent %s', async (agent, folder, otherFolder) => {
    const installed = join(paths.home, folder, 'skills', NAME)
    await writeCopy(installed, OLD_TEXT)

    const result = await runJson<RunJson>(['update', '--skill', NAME, '--agent', agent])

    expect(result.notInstalled).toEqual([])
    expect(result.result.skills[0].ops.map((op) => op.path)).toEqual([installed])
    expect(await skillText(installed)).toBe(NEW_TEXT)
    expect(await lstat(join(paths.home, otherFolder, 'skills', NAME)).catch(() => null)).toBeNull()
    expect(await lstat(paths.shared).catch(() => null)).toBeNull()
    expect(process.exitCode).toBe(0)
  })

  it('detects agents when --agent is omitted', async () => {
    await writeCopy(paths.shared, NEW_TEXT)

    const plan = await runJson<DryRunJson>(['install', '--skill', NAME, '--dry-run'])

    expect(detectAgentsMock).toHaveBeenCalled()
    expect(plan.plan.skills[0].ops.map((op) => op.path)).toEqual([paths.shared, paths.claude])
  })

  it('rejects an unknown --agent value', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'install', '--skill', NAME, '--agent', 'nope'], paths.root)

    expect(process.exitCode).toBe(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('Unknown --agent value "nope"')
  })

  it('plans the current project for --local, linking only into agent folders it has', async () => {
    const project = join(paths.root, 'project')
    await mkdir(join(project, '.claude', 'skills'), { recursive: true })
    vi.spyOn(process, 'cwd').mockReturnValue(project)

    await run(['install', '--skill', NAME, '--agent', 'claude,droid', '--local'])

    const projectShared = join(project, '.agents', 'skills', NAME)
    expect(await skillText(projectShared)).toBe(NEW_TEXT)
    expect(await realpath(join(project, '.claude', 'skills', NAME))).toBe(projectShared)
    expect((await readlink(join(project, '.claude', 'skills', NAME))).startsWith('/')).toBe(false)
    expect(await readdir(project)).toEqual(['.agents', '.claude'])
    expect(await lstat(paths.shared).catch(() => null)).toBeNull()
  })
})
