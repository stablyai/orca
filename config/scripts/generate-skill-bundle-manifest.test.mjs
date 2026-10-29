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
import { parse } from 'yaml'
import { observeSkillPackage } from '../../src/main/skills/skill-package-identity'
import {
  classifyFile,
  collectPackageFiles,
  describeFile,
  findDroppedReleasedDigests,
  normalizeText,
  packageDigest,
  sortManifestFiles,
  withDigests
} from './generate-skill-bundle-manifest.mjs'

const temporaryDirectories = []
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

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
  const script = path.join(root, 'config', 'scripts', 'generate-skill-bundle-manifest.mjs')
  await mkdir(path.dirname(script), { recursive: true })
  await mkdir(skillRoot, { recursive: true })
  for (const name of ['generate-skill-bundle-manifest.mjs', 'git-pull-request-diff-base.mjs']) {
    await copyFile(path.join(import.meta.dirname, name), path.join(path.dirname(script), name))
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
  it('folds platform line endings for text identity', () => {
    const lf = Buffer.from('first\nsecond\n')
    const crlf = Buffer.from('first\r\nsecond\r\n')

    expect(classifyFile(lf)).toBe('text')
    expect(normalizeText(crlf)).toEqual(lf)
  })

  it('classifies null-containing and invalid UTF-8 content as binary', () => {
    expect(classifyFile(Buffer.from([0, 1, 2]))).toBe('binary')
    expect(classifyFile(Buffer.from([0xc3, 0x28]))).toBe('binary')
  })

  it('uses normalized text identity but exact executable identity', () => {
    const skillFile = describeFile('SKILL.md', Buffer.from('line one\r\nline two\r\n'), false)
    const executable = describeFile('run.sh', Buffer.from('#!/bin/sh\r\necho ok\r\n'), true)

    expect(skillFile.identitySha256).toBe(skillFile.textNormalizedSha256)
    expect(skillFile.identitySha256).not.toBe(skillFile.exactSha256)
    expect(executable.exactSha256).not.toBe(executable.textNormalizedSha256)
    expect(executable.identitySha256).toBe(executable.exactSha256)
    expect(packageDigest([skillFile, executable])).toMatch(/^[a-f0-9]{64}$/)
  })

  it('orders files identically however they were listed', async () => {
    const packageRoot = await createPackage()
    await mkdir(path.join(packageRoot, 'sub'))
    for (const name of ['apple.md', 'sub.md', 'Zebra.md', path.join('sub', 'inner.txt')]) {
      await writeFile(path.join(packageRoot, name), `${name}\n`)
    }
    const walked = await collectPackageFiles(packageRoot)

    // Git tree ordering differs from depth-first filesystem ordering; hash producers must agree.
    const gitOrdered = ['Zebra.md', 'apple.md', 'sub.md', 'sub/inner.txt'].map((manifestPath) =>
      walked.find((file) => file.path === manifestPath)
    )

    expect(sortManifestFiles(gitOrdered)).toEqual(walked)
    expect(packageDigest(sortManifestFiles(gitOrdered))).toBe(packageDigest(walked))
    expect(walked.map((file) => file.path)).toEqual([
      'Zebra.md',
      'apple.md',
      'sub/inner.txt',
      'sub.md'
    ])
  })

  it('writes a schema-3 manifest and fails verification once a skill changes', async () => {
    const sandbox = await createGeneratorSandbox()
    sandbox.generate('--write')
    const manifest = JSON.parse(await sandbox.read('current-manifest.json'))
    expect(manifest.schemaVersion).toBe(3)
    expect(manifest.skills.map((skill) => Object.keys(skill))).toEqual([
      ['name', 'sourcePath', 'packageDigest', 'files']
    ])
    expect(() => sandbox.generate()).not.toThrow()

    await sandbox.editSkill('changed\n')
    expect(() => sandbox.generate()).toThrow()
  })

  it('keeps every shipped SKILL.md digest and embeds the current LF bytes', async () => {
    const sandbox = await createGeneratorSandbox()
    sandbox.generate('--write')
    const [first] = JSON.parse(await sandbox.read('released-digests.json')).skills.demo

    await sandbox.editSkill('changed\r\n')
    sandbox.generate('--write')
    const ledger = JSON.parse(await sandbox.read('released-digests.json'))
    expect(ledger.skills.demo).toHaveLength(2)
    expect(ledger.skills.demo).toContain(first)
    expect(await sandbox.readSources()).toContain(
      JSON.stringify({ name: 'demo', text: 'changed\n', releasedDigests: ledger.skills.demo })
    )
    expect(() => sandbox.generate()).not.toThrow()
  })

  it('collects every SKILL.md version in git history, even ones never generated', async () => {
    const sandbox = await createGeneratorSandbox()
    sandbox.git('init', '-q')
    sandbox.git('add', 'skills')
    sandbox.git('commit', '-qm', 'one')
    await sandbox.editSkill('second version\n')
    sandbox.git('commit', '-qam', 'two')
    await sandbox.editSkill('third version\n')
    sandbox.generate('--write')
    expect(JSON.parse(await sandbox.read('released-digests.json')).skills.demo).toHaveLength(3)
    expect(() => sandbox.generate()).not.toThrow()
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

  it('merges digests without duplicates and reports any the base had but HEAD lost', () => {
    const merged = withDigests({ skills: { demo: ['b'] } }, [['demo', ['a', 'b', 'a']]])
    expect(merged.skills.demo).toEqual(['a', 'b'])
    expect(findDroppedReleasedDigests({ skills: { demo: ['a', 'b'] } }, merged)).toEqual([])
    expect(
      findDroppedReleasedDigests({ skills: { demo: ['a', 'c'], gone: ['d'] } }, merged)
    ).toEqual(['demo:c', 'gone:d'])
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

  it.runIf(process.platform !== 'win32')('rejects symlinks inside shipped packages', async () => {
    const packageRoot = await createPackage()
    await writeFile(path.join(packageRoot, 'SKILL.md'), 'skill')
    await symlink('SKILL.md', path.join(packageRoot, 'linked.md'))

    await expect(collectPackageFiles(packageRoot)).rejects.toThrow(
      'Symlink is not allowed in a shipped skill'
    )
  })

  it('ignores OS-authored sidecars a working tree may carry', async () => {
    const packageRoot = await createPackage()
    await writeFile(path.join(packageRoot, 'SKILL.md'), 'demo skill\n')
    await mkdir(path.join(packageRoot, 'references'))
    await writeFile(path.join(packageRoot, 'references', 'guide.md'), 'nested\n')
    const pristine = await collectPackageFiles(packageRoot)
    expect(pristine.map((file) => file.path)).toEqual(['SKILL.md', 'references/guide.md'])
    // Ignored Finder sidecars must not stale committed artifacts or create manifests no runtime observation matches.
    await writeFile(path.join(packageRoot, '.DS_Store'), Buffer.from([0, 1, 2, 3]))
    await writeFile(path.join(packageRoot, '._SKILL.md'), Buffer.from([0, 5]))
    await writeFile(path.join(packageRoot, 'Thumbs.db'), Buffer.from([9]))
    // Nested folders get browsed too, and a sidecar there shifts the same index-aligned list.
    await writeFile(path.join(packageRoot, 'references', '.DS_Store'), Buffer.from([7]))

    expect(await collectPackageFiles(packageRoot)).toEqual(pristine)
  })

  it('still records an unexpected file that is not OS metadata', async () => {
    const packageRoot = await createPackage()
    await writeFile(path.join(packageRoot, 'SKILL.md'), 'demo skill\n')
    await writeFile(path.join(packageRoot, 'payload.sh'), 'echo hi\n')

    expect((await collectPackageFiles(packageRoot)).map((file) => file.path)).toEqual([
      'SKILL.md',
      'payload.sh'
    ])
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
  it('skips exactly the names the scanner skips', async () => {
    const packageRoot = await createPackage()
    for (const name of [
      'SKILL.md',
      '.DS_Store',
      '.ds_store',
      '.DS_STORE',
      'Thumbs.db',
      'THUMBS.DB',
      'ehthumbs.db',
      'desktop.ini',
      'Desktop.INI',
      '._SKILL.md',
      '._',
      // Near misses that both sides must keep.
      '.dsstore',
      'ds_store.md',
      '_SKILL.md',
      '.DS_Store.md'
    ]) {
      await writeFile(path.join(packageRoot, name), `${name}\n`)
    }

    const generated = (await collectPackageFiles(packageRoot)).map((file) => file.path)
    expect(generated).toEqual((await observeSkillPackage(packageRoot)).files.map((f) => f.path))
    expect(generated).toEqual(['.DS_Store.md', '.dsstore', 'SKILL.md', '_SKILL.md', 'ds_store.md'])
  })

  // Release steps share index; a prior step can stage regenerated manifest into bump commit. Pin cut’s committed-artifact guard and spellings.
  it('keeps the whole release-cut job off skill regeneration', async () => {
    const workflow = parse(
      await readFile(path.join(REPO_ROOT, '.github/workflows/release-cut.yml'), 'utf8')
    )
    const runSteps = workflow.jobs.cut.steps
      .filter((step) => typeof step.run === 'string')
      .map((step) => ({ name: step.name ?? '(unnamed)', run: step.run.replace(/^\s*#.*$/gm, '') }))
    const bumpStep = runSteps.find((step) => step.name === 'Bump package.json and tag')

    // Check commit, not index (commit flags can bypass it); -F keeps dot literal, -m exposes merge changes.
    expect(bumpStep.run).toMatch(
      /git diff-tree --no-commit-id --name-only -r -m --first-parent HEAD\s*\|\s*grep -vxF -e 'package\.json'/
    )
    expect(bumpStep.run.indexOf('grep -vxF')).toBeLessThan(bumpStep.run.indexOf('git tag'))
    // ...and that it aborts. A guard degraded to a warning still reads as covered.
    expect(bumpStep.run).toMatch(
      /if \[\[ -n "\$committed" \]\]; then(?:(?!\bfi\b)[\s\S])*exit 1[\s\S]*?fi/
    )
    for (const step of runSteps) {
      expect(step.run, step.name).not.toMatch(
        /resources[/\\]skills|--write|generate:skill-bundle-manifest/
      )
    }
  })
})
