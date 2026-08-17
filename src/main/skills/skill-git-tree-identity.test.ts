import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SkillBundleManifest } from '../../shared/skill-freshness'
import { observeSkillPackage } from './skill-package-identity'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

describe('observed skill git tree identity', () => {
  // The decisive check: the runtime port must reproduce the generator's tree
  // sha bit-for-bit, or the lock comparison never matches and the verdict fix
  // is a silent no-op. The manifest's gitTreeSha values are generated from
  // these same working-tree bytes.
  it('matches the gitTreeSha the bundled manifest records for every shipped skill', async () => {
    const manifest = JSON.parse(
      await readFile(join(REPO_ROOT, 'resources', 'skills', 'current-manifest.json'), 'utf8')
    ) as SkillBundleManifest
    expect(manifest.skills.length).toBeGreaterThan(0)
    for (const skill of manifest.skills) {
      const observed = await observeSkillPackage(join(REPO_ROOT, 'skills', skill.name))
      expect(observed.observedGitTreeSha, skill.name).toBe(skill.gitTreeSha)
    }
  })

  // Shipped skills are flat today, so this covers what they do not: nested
  // directories, an executable, binary bytes, and the `z.txt` vs `z/` edge where
  // git's slash-append ordering diverges from a plain name sort.
  it('matches git write-tree over nesting, executables and the directory sort edge', async () => {
    const base = await mkdtemp(join(tmpdir(), 'orca-skill-tree-sha-'))
    temporaryDirectories.push(base)
    const work = join(base, 'work')
    const repoShell = join(base, 'repo')
    await mkdir(join(work, 'z'), { recursive: true })
    await mkdir(join(work, 'nested', 'deep'), { recursive: true })
    await mkdir(repoShell, { recursive: true })
    await writeFile(join(work, 'SKILL.md'), '---\nname: fixture\n---\n')
    await writeFile(join(work, 'z.txt'), 'sorts before the z directory\n')
    await writeFile(join(work, 'z', 'inner.md'), 'directory entry\n')
    await writeFile(join(work, 'nested', 'deep', 'tool.sh'), '#!/bin/sh\nexit 0\n')
    await chmod(join(work, 'nested', 'deep', 'tool.sh'), 0o755)
    await writeFile(join(work, 'blob.bin'), Buffer.from([0, 1, 2, 253, 254, 255]))

    const globalConfig = join(base, 'global.gitconfig')
    const systemConfig = join(base, 'system.gitconfig')
    await Promise.all([writeFile(globalConfig, ''), writeFile(systemConfig, '')])
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: systemConfig
    }
    execFileSync('git', ['init', '--quiet', repoShell], { env })
    const gitDirArgs = ['--git-dir', join(repoShell, '.git'), '--work-tree', work]
    execFileSync('git', [...gitDirArgs, '-c', 'core.autocrlf=false', 'add', '-A'], {
      env,
      cwd: work
    })
    const expected = execFileSync('git', [...gitDirArgs, 'write-tree'], {
      env,
      cwd: work,
      encoding: 'utf8'
    }).trim()

    const observed = await observeSkillPackage(work)
    expect(observed.observedGitTreeSha).toBe(expected)
  })
})
