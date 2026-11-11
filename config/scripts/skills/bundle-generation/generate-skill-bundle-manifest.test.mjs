import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectPackageFiles } from './generate-skill-bundle-manifest.mjs'

const temporaryDirectories = []

async function createPackage() {
  const directory = await mkdtemp(path.join(tmpdir(), 'orca-skill-manifest-'))
  temporaryDirectories.push(directory)
  return directory
}

// Why strip GITHUB_*: on a CI pull_request the add-only check looks for a base the sandbox lacks.
function localEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GITHUB_'))
  )
}

// Copy generator into throwaway tree so its location-based root resolves there, protecting resources/skills.
async function createGeneratorSandbox() {
  // Resolve sandbox path: Node resolves script symlinks before its root check.
  const root = await realpath(await createPackage())
  const skillRoot = path.join(root, 'skills', 'demo')
  const script = path.join(
    root,
    'config',
    'scripts',
    'skills',
    'bundle-generation',
    'generate-skill-bundle-manifest.mjs'
  )
  await mkdir(path.dirname(script), { recursive: true })
  await mkdir(skillRoot, { recursive: true })
  await mkdir(path.join(root, 'src', 'shared'), { recursive: true })
  await copyFile(
    path.resolve(import.meta.dirname, '../../../../src/shared/bundled-skill-renames.json'),
    path.join(root, 'src', 'shared', 'bundled-skill-renames.json')
  )
  for (const relative of [
    'config/scripts/skills/bundle-generation/generate-skill-bundle-manifest.mjs',
    'config/scripts/git/pr-diff-base/git-pull-request-diff-base.mjs'
  ]) {
    const destination = path.join(root, relative)
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(path.resolve(import.meta.dirname, '../../../..', relative), destination)
  }
  await writeFile(path.join(skillRoot, 'SKILL.md'), 'demo skill\n')
  const run = (env, args) =>
    execFileSync(process.execPath, [script, ...args], { stdio: 'pipe', env })
  return {
    root,
    generate: (...args) => run(localEnv(), args),
    generateOnPullRequest: (...args) =>
      run({ ...localEnv(), GITHUB_EVENT_NAME: 'pull_request' }, args),
    git: (...args) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: root,
        stdio: 'pipe',
        env: localEnv()
      }),
    read: (name) => readFile(path.join(root, 'resources', 'skills', name), 'utf8'),
    readSources: () =>
      readFile(
        path.join(
          root,
          'src',
          'main',
          'skills',
          'bundled-skill-install',
          'bundled-skill-sources.ts'
        ),
        'utf8'
      ),
    editSkill: (body) => writeFile(path.join(skillRoot, 'SKILL.md'), body)
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('skill bundle manifest generator', () => {
  it('orders complete manifest paths when a reference file shares a directory stem', async () => {
    const packageRoot = await createPackage()
    await mkdir(path.join(packageRoot, 'references', 'refs'), { recursive: true })
    await writeFile(path.join(packageRoot, 'SKILL.md'), 'skill\n')
    await writeFile(path.join(packageRoot, 'references', 'refs.md'), 'reference\n')
    await writeFile(path.join(packageRoot, 'references', 'refs', 'image.webp'), Buffer.from([0]))

    expect((await collectPackageFiles(packageRoot)).map((file) => file.path)).toEqual([
      'SKILL.md',
      'references/refs.md',
      'references/refs/image.webp'
    ])
  })

  it('keeps SKILL.md bytes only a release tag shipped, off HEAD', async () => {
    const sandbox = await createGeneratorSandbox()
    sandbox.git('init', '-q', '-b', 'main')
    sandbox.git('add', 'skills')
    sandbox.git('commit', '-qm', 'one')
    sandbox.git('checkout', '-qb', 'release')
    await sandbox.editSkill('release-only version\n')
    sandbox.git('commit', '-qam', 'release cut')
    sandbox.git('tag', 'v1.0.0')
    sandbox.git('checkout', '-q', 'main')
    await sandbox.editSkill('demo skill\n')
    sandbox.generate('--write')
    const digests = JSON.parse(await sandbox.read('released-digests.json')).skills.demo
    expect(digests).toContain(createHash('sha256').update('release-only version\n').digest('hex'))
    expect(digests).toHaveLength(2)
  })

  it('fails when a digest is missing or the pull request base cannot be read', async () => {
    const sandbox = await createGeneratorSandbox()
    sandbox.generate('--write')
    expect(() => sandbox.generateOnPullRequest()).toThrow(/Cannot read the pull request base/)
    await writeFile(
      path.join(sandbox.root, 'resources', 'skills', 'released-digests.json'),
      `${JSON.stringify({ schemaVersion: 1, skills: { demo: [] } }, null, 2)}\n`
    )
    expect(() => sandbox.generate()).toThrow(/stale/)
  })

  it.runIf(process.platform !== 'win32')(
    'rejects executable files in shipped skill packages',
    async () => {
      const packageRoot = await createPackage()
      await writeFile(path.join(packageRoot, 'SKILL.md'), 'skill\n')
      await writeFile(path.join(packageRoot, 'run.sh'), '#!/bin/sh\necho ok\n')
      await chmod(path.join(packageRoot, 'run.sh'), 0o755)

      await expect(collectPackageFiles(packageRoot)).rejects.toThrow(
        'Executable file is not allowed in a shipped skill: run.sh'
      )
    }
  )

  it.runIf(process.platform === 'linux')('rejects case-colliding paths', async () => {
    const packageRoot = await createPackage()
    await writeFile(path.join(packageRoot, 'SKILL.md'), 'skill')
    await writeFile(path.join(packageRoot, 'Readme.md'), 'one')
    await writeFile(path.join(packageRoot, 'README.md'), 'two')

    await expect(collectPackageFiles(packageRoot)).rejects.toThrow('Case-colliding skill paths')
  })

  it('keeps guarding a directory or link that only wears an OS metadata name', async () => {
    const packageRoot = await createPackage()
    await writeFile(path.join(packageRoot, 'SKILL.md'), 'demo skill\n')
    // Sidecar-named directories are real content; dropping them ships unrecorded subtrees.
    await mkdir(path.join(packageRoot, '.DS_Store'))
    await writeFile(path.join(packageRoot, '.DS_Store', 'payload.sh'), 'echo hi\n')

    expect((await collectPackageFiles(packageRoot)).map((file) => file.path)).toEqual([
      '.DS_Store/payload.sh',
      'SKILL.md'
    ])

    if (process.platform !== 'win32') {
      await rm(path.join(packageRoot, '.DS_Store'), { recursive: true })
      await symlink('SKILL.md', path.join(packageRoot, '._SKILL.md'))
      await expect(collectPackageFiles(packageRoot)).rejects.toThrow(
        'Symlink is not allowed in a shipped skill'
      )
    }
  })

  // Compare both walkers: asymmetric sidecar rules strand installs as unrecognized; include order and case-fold behavior too.
})
