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
import { isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BundledSkillInstallResult, BundledSkillPlan } from '../../shared/bundled-skill-plan'

const NAME = 'orca-cli'
const OLD_TEXT = `---\nname: ${NAME}\ndescription: Old\n---\n\nOld body\n`
const NEW_TEXT = `---\nname: ${NAME}\ndescription: New\n---\n\nNew body\n`
const EDITED_TEXT = `---\nname: ${NAME}\n---\nmine\n`
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

const { detectAgentsMock } = vi.hoisted(() => ({ detectAgentsMock: vi.fn() }))

// Use the real installer in a temporary home; pin bundled bytes and agent detection for portability.
vi.mock('../../main/skills/bundled-skill-install/bundled-skill-sources', () => ({
  BUNDLED_SKILL_SOURCES: [
    { name: NAME, text: NEW_TEXT, releasedDigests: [sha(OLD_TEXT), sha(NEW_TEXT)] }
  ]
}))
vi.mock('../../main/preflight/installed-agent-detection', () => ({
  detectInstalledAgentsWithShellPathHydration: detectAgentsMock
}))
// Avoid the production five-second lock wait in tests.
vi.mock(
  '../../main/skills/bundled-skill-install/bundled-skill-local-host',
  async (importOriginal) => {
    const actual = await importOriginal<typeof LocalHost>()
    return {
      localBundledSkillInput: async (
        ...args: Parameters<typeof actual.localBundledSkillInput>
      ) => ({
        ...(await actual.localBundledSkillInput(...args)),
        lockTimeoutMs: 0
      })
    }
  }
)

import type * as LocalHost from '../../main/skills/bundled-skill-install/bundled-skill-local-host'
import { main } from '../index'
import {
  acquireSkillInstallLock,
  skillInstallLockPath
} from '../../main/skills/transaction-state/skill-install-lock'

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

  it('plans the current project for --local, linking only into agent folders it has', async () => {
    const project = join(paths.root, 'project')
    await mkdir(join(project, '.claude', 'skills'), { recursive: true })
    vi.spyOn(process, 'cwd').mockReturnValue(project)

    await run(['install', '--skill', NAME, '--agent', 'claude,droid', '--local'])

    const projectShared = join(project, '.agents', 'skills', NAME)
    expect(await skillText(projectShared)).toBe(NEW_TEXT)
    expect(await realpath(join(project, '.claude', 'skills', NAME))).toBe(projectShared)
    expect(isAbsolute(await readlink(join(project, '.claude', 'skills', NAME)))).toBe(
      process.platform === 'win32'
    )
    expect(await readdir(project)).toEqual(['.agents', '.claude'])
    expect(await lstat(paths.shared).catch(() => null)).toBeNull()
  })
})
