import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCodexSkillSourcesStamp } from './codex-skill-sources-stamp'

let root: string
let clock = 0

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codex-skill-stamp-'))
  await mkdir(join(root, 'home', '.agents', 'skills'), { recursive: true })
  await mkdir(join(root, 'codex-home'), { recursive: true })
  await mkdir(join(root, 'repo', '.git'), { recursive: true })
  await writeFile(join(root, 'codex-home', 'config.toml'), TRUSTED)
})

const TRUSTED = '[projects."/tmp/a"]\ntrust_level = "trusted"\n'

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeSkill(directory: string, name: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`)
}

function stamper(accountHome = join(root, 'codex-home')) {
  const stamp = createCodexSkillSourcesStamp({
    now: () => clock,
    homeDir: () => join(root, 'home'),
    systemCodexHome: () => join(root, 'codex-home'),
    managedCodexHome: () => join(root, 'managed-home')
  })
  return async () => {
    // Step past the shared per-root reuse window between reads.
    clock += 10_000
    return stamp(accountHome, join(root, 'repo'), new AbortController().signal)
  }
}

describe('Codex skill sources stamp', () => {
  it.each([
    ['a user skill', () => writeSkill(join(root, 'home', '.agents', 'skills', 'perf-scan'), 'p')],
    [
      'a linked user skill',
      async () => {
        await writeSkill(join(root, 'elsewhere', 'perf-scan'), 'p')
        await symlink(
          join(root, 'elsewhere', 'perf-scan'),
          join(root, 'home', '.agents', 'skills', 'perf-scan'),
          'dir'
        )
      }
    ],
    [
      'a nested user skill',
      () => writeSkill(join(root, 'home', '.agents', 'skills', 'synced', 'x', 'perf-scan'), 'p')
    ],
    ['a repo skill', () => writeSkill(join(root, 'repo', '.agents', 'skills', 'perf-scan'), 'p')],
    [
      'a project plugin',
      async () => {
        await mkdir(join(root, 'repo', '.codex'), { recursive: true })
        await writeFile(
          join(root, 'repo', '.codex', 'config.toml'),
          '[plugins."docs@openai"]\nenabled = true\n'
        )
      }
    ],
    [
      'a quoted plugin table',
      () =>
        writeFile(
          join(root, 'codex-home', 'config.toml'),
          `${TRUSTED}['plugins'.'demo@local']\nenabled = true\n`
        )
    ],
    [
      'a dotted plugin key',
      () =>
        writeFile(
          join(root, 'codex-home', 'config.toml'),
          `plugins."demo@local".enabled = true\n${TRUSTED}`
        )
    ],
    [
      'a disabled skill',
      () =>
        writeFile(
          join(root, 'codex-home', 'config.toml'),
          `${TRUSTED}[[skills.config]]\npath = "/s/SKILL.md"\nenabled = false\n`
        )
    ]
  ])('changes when %s is added', async (_label, change) => {
    const read = stamper()
    const before = await read()
    await change()
    const after = await read()
    expect(before).toBeDefined()
    expect(after).not.toBe(before)
  })

  it('ignores config edits outside skills and plugins', async () => {
    const read = stamper()
    const before = await read()
    await writeFile(
      join(root, 'codex-home', 'config.toml'),
      `${TRUSTED}[projects."/tmp/new-worktree"]\ntrust_level = "trusted"\n`
    )
    expect(await read()).toBe(before)
  })

  it("ignores the managed home's config copy, which the probe rewrites from the source", async () => {
    const managed = join(root, 'managed-home')
    await mkdir(managed, { recursive: true })
    const read = stamper(managed)
    const before = await read()
    await writeFile(join(managed, 'config.toml'), '[plugins."docs@openai"]\nenabled = true\n')
    expect(await read()).toBe(before)
  })
})
