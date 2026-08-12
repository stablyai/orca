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
  appendReleaseRow,
  assertReleasedHistoryPreserved,
  classifyFile,
  collectPackageFiles,
  describeFile,
  gitTreeSha,
  isToleratedReleaseMappingPrefix,
  normalizeText,
  packageDigest,
  releasedHistoryFromCommitted,
  sortManifestFiles
} from './generate-skill-bundle-manifest.mjs'

const temporaryDirectories = []
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

async function createPackage() {
  const directory = await mkdtemp(path.join(tmpdir(), 'orca-skill-manifest-'))
  temporaryDirectories.push(directory)
  return directory
}

// Why: the generator resolves its repo root from its own location, so a copy of
// the script inside a throwaway tree exercises the real CLI — including which
// artifacts each mode is allowed to write — without touching resources/skills.
async function createReleaseSandbox() {
  // Node resolves the entry point through symlinks, so the script's own
  // repo-root check only matches when the sandbox path is already resolved.
  const root = await realpath(await createPackage())
  const skillRoot = path.join(root, 'skills', 'demo')
  const script = path.join(root, 'config', 'scripts', 'generate-skill-bundle-manifest.mjs')
  await mkdir(path.dirname(script), { recursive: true })
  await mkdir(skillRoot, { recursive: true })
  await copyFile(path.join(import.meta.dirname, 'generate-skill-bundle-manifest.mjs'), script)
  await writeFile(path.join(skillRoot, 'SKILL.md'), 'demo skill\n')
  return {
    generate: (...args) => execFileSync(process.execPath, [script, ...args], { stdio: 'pipe' }),
    read: (name) => readFile(path.join(root, 'resources', 'skills', name), 'utf8'),
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

  it('orders git-history files identically to the filesystem walk', async () => {
    const packageRoot = await createPackage()
    await mkdir(path.join(packageRoot, 'sub'))
    for (const name of ['apple.md', 'sub.md', 'Zebra.md', path.join('sub', 'inner.txt')]) {
      await writeFile(path.join(packageRoot, name), `${name}\n`)
    }
    const walked = await collectPackageFiles(packageRoot)

    // Why: git ls-tree emits [Zebra.md, apple.md, sub.md, sub/inner.txt]; index-based
    // snapshot matching requires history and observation to share one order.
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

  it('rejects rewrites of released snapshots and allows floating-tail replacement', () => {
    const snapshot = (releaseRevision, packageDigest) => ({ releaseRevision, packageDigest })
    const artifacts = {
      releasedSnapshotCounts: { 'orca-cli': 2 },
      snapshotRegistry: {
        schemaVersion: 1,
        skills: { 'orca-cli': [snapshot(1, 'aaa'), snapshot(2, 'bbb'), snapshot(3, 'ccc')] }
      }
    }

    expect(() =>
      assertReleasedHistoryPreserved(
        { schemaVersion: 1, skills: { 'orca-cli': [snapshot(1, 'aaa'), snapshot(2, 'bbb')] } },
        artifacts
      )
    ).not.toThrow()
    expect(() =>
      assertReleasedHistoryPreserved(
        {
          schemaVersion: 1,
          skills: { 'orca-cli': [snapshot(1, 'aaa'), snapshot(2, 'bbb'), snapshot(3, 'stale')] }
        },
        artifacts
      )
    ).not.toThrow()
    expect(() =>
      assertReleasedHistoryPreserved(
        {
          schemaVersion: 1,
          skills: { 'orca-cli': [snapshot(1, 'aaa'), snapshot(2, 'rewritten')] }
        },
        artifacts
      )
    ).toThrow('Released snapshot history changed for orca-cli at revision 2')
    expect(() =>
      assertReleasedHistoryPreserved(
        {
          schemaVersion: 1,
          skills: {
            'orca-cli': [snapshot(1, 'aaa'), { ...snapshot(2, 'bbb'), gitTreeSha: 'rewritten' }]
          }
        },
        artifacts
      )
    ).toThrow('Released snapshot history changed for orca-cli at revision 2')
    expect(() =>
      assertReleasedHistoryPreserved(
        {
          schemaVersion: 1,
          skills: {
            'orca-cli': [snapshot(1, 'aaa'), snapshot(2, 'bbb'), snapshot(3, 'stale')]
          }
        },
        { ...artifacts, releasedSnapshotCounts: { 'orca-cli': 1 } }
      )
    ).toThrow('Released snapshot history is incomplete for orca-cli')
    expect(() => assertReleasedHistoryPreserved(null, artifacts)).not.toThrow()
  })

  it('protects only revisions named by the committed release mapping', () => {
    const snapshot = (releaseRevision, packageDigest) => ({ releaseRevision, packageDigest })
    const committedRegistry = {
      schemaVersion: 1,
      skills: {
        'linear-tickets': [snapshot(1, 'released'), snapshot(2, 'unreleased-tail')]
      }
    }
    const artifacts = {
      releasedSnapshotCounts: { 'linear-tickets': 2 },
      snapshotRegistry: {
        schemaVersion: 1,
        skills: { 'linear-tickets': [snapshot(1, 'released'), snapshot(2, 'new-release')] }
      }
    }

    expect(() =>
      assertReleasedHistoryPreserved(committedRegistry, artifacts, {
        schemaVersion: 1,
        releases: [{ appVersion: '1.0.0', skills: { 'linear-tickets': 1 } }]
      })
    ).not.toThrow()
    expect(() =>
      assertReleasedHistoryPreserved(committedRegistry, artifacts, {
        schemaVersion: 1,
        releases: [{ appVersion: '1.0.0', skills: { 'linear-tickets': 2 } }]
      })
    ).toThrow('Released snapshot history changed for linear-tickets at revision 2')
  })

  it('tolerates only redundant trailing release-mapping rows', () => {
    const serialized = (value) => `${JSON.stringify(value, null, 2)}\n`
    const rows = [
      { appVersion: '1.0.0', skills: { 'orca-cli': 1 } },
      { appVersion: '1.1.0', skills: { 'orca-cli': 2 } }
    ]
    const artifacts = {
      currentManifest: { skills: [{ name: 'orca-cli', releaseRevision: 2 }] },
      releaseMapping: { schemaVersion: 1, releases: rows }
    }
    const committedPrefix = serialized({ schemaVersion: 1, releases: [rows[0]] })

    // A just-cut tag whose bytes equal the working tree may lag in the mapping.
    expect(isToleratedReleaseMappingPrefix(committedPrefix, artifacts)).toBe(true)
    // The committed file matching the derived mapping is byte-equality's job, not tolerance.
    expect(isToleratedReleaseMappingPrefix(serialized(artifacts.releaseMapping), artifacts)).toBe(
      false
    )
    // A trailing row for bytes the committed artifacts do not describe is a real gap.
    expect(
      isToleratedReleaseMappingPrefix(committedPrefix, {
        ...artifacts,
        currentManifest: { skills: [{ name: 'orca-cli', releaseRevision: 3 }] }
      })
    ).toBe(false)
    expect(
      isToleratedReleaseMappingPrefix(committedPrefix, {
        ...artifacts,
        currentManifest: {
          skills: [
            { name: 'orca-cli', releaseRevision: 2 },
            { name: 'orca-linear', releaseRevision: 1 }
          ]
        }
      })
    ).toBe(false)
    // Rewritten earlier rows never pass, with or without trailing rows.
    expect(
      isToleratedReleaseMappingPrefix(
        serialized({
          schemaVersion: 1,
          releases: [{ appVersion: '0.9.0', skills: { 'orca-cli': 1 } }]
        }),
        artifacts
      )
    ).toBe(false)
    expect(isToleratedReleaseMappingPrefix('not json', artifacts)).toBe(false)
    expect(isToleratedReleaseMappingPrefix(serialized({ schemaVersion: 1 }), artifacts)).toBe(false)
  })

  it('seeds released history from the committed ledger and drops the floating tail', () => {
    const snapshot = (releaseRevision, packageDigest) => ({ releaseRevision, packageDigest })
    const committedRegistry = {
      schemaVersion: 1,
      skills: {
        // released revs 1..2 named by the mapping, plus an unreleased tail at 3
        'orca-cli': [snapshot(1, 'aaa'), snapshot(2, 'bbb'), snapshot(3, 'unreleased')],
        // no mapping row -> fall back to all-but-tail
        'orca-linear': [snapshot(1, 'ccc'), snapshot(2, 'tail')]
      }
    }
    const committedMapping = {
      schemaVersion: 1,
      releases: [{ appVersion: '1.0.0', skills: { 'orca-cli': 2 } }]
    }

    const seeded = releasedHistoryFromCommitted(committedRegistry, committedMapping)

    // The unreleased tail is dropped; only mapping-named revisions survive.
    expect(seeded.registry.skills['orca-cli']).toEqual([snapshot(1, 'aaa'), snapshot(2, 'bbb')])
    expect(seeded.registry.skills['orca-linear']).toEqual([snapshot(1, 'ccc')])
    expect(seeded.releasedSnapshotCounts).toEqual({ 'orca-cli': 2, 'orca-linear': 1 })
    // The seed clones the mapping so a later release append cannot alias committed state.
    expect(seeded.mapping).toEqual(committedMapping)
    expect(seeded.mapping).not.toBe(committedMapping)
  })

  it('returns an empty ledger when no committed artifacts exist', () => {
    const seeded = releasedHistoryFromCommitted(null, null)
    expect(seeded.registry.skills).toEqual({})
    expect(seeded.releasedSnapshotCounts).toEqual({})
    expect(seeded.mapping.releases).toEqual([])
  })

  it('appends one release row, stripping the v-prefix and deduping identical tails', () => {
    const artifacts = {
      currentManifest: {
        skills: [
          { name: 'orca-cli', releaseRevision: 36 },
          { name: 'orca-linear', releaseRevision: 8 }
        ]
      },
      releaseMapping: {
        schemaVersion: 1,
        releases: [{ appVersion: '1.4.151', skills: { 'orca-cli': 35, 'orca-linear': 8 } }]
      }
    }

    appendReleaseRow(artifacts, 'v1.4.160')
    expect(artifacts.releaseMapping.releases.at(-1)).toEqual({
      appVersion: '1.4.160',
      skills: { 'orca-cli': 36, 'orca-linear': 8 }
    })

    // A second release over identical revisions adds no row.
    appendReleaseRow(artifacts, '1.4.161')
    expect(artifacts.releaseMapping.releases).toHaveLength(2)
  })

  it('overwrites the trailing row when a failed cut is re-cut at the same version', () => {
    const artifacts = {
      currentManifest: { skills: [{ name: 'orca-cli', releaseRevision: 37 }] },
      releaseMapping: {
        schemaVersion: 1,
        releases: [
          { appVersion: '1.4.151', skills: { 'orca-cli': 35 } },
          // The failed cut already pushed this row to main at revision 36.
          { appVersion: '1.4.160', skills: { 'orca-cli': 36 } }
        ]
      }
    }

    appendReleaseRow(artifacts, '1.4.160')

    // One row per version: the tag ships revision 37, so 36 must not linger.
    expect(artifacts.releaseMapping.releases).toEqual([
      { appVersion: '1.4.151', skills: { 'orca-cli': 35 } },
      { appVersion: '1.4.160', skills: { 'orca-cli': 37 } }
    ])
  })

  it('refuses to rewrite an already-shipped version behind the trailing row', () => {
    const artifacts = {
      currentManifest: { skills: [{ name: 'orca-cli', releaseRevision: 37 }] },
      releaseMapping: {
        schemaVersion: 1,
        releases: [
          { appVersion: '1.4.151', skills: { 'orca-cli': 35 } },
          { appVersion: '1.4.160', skills: { 'orca-cli': 36 } }
        ]
      }
    }

    expect(() => appendReleaseRow(artifacts, '1.4.151')).toThrow(/already has a row for 1\.4\.151/)
  })

  it('records a release without regenerating the content-addressed artifacts', async () => {
    const sandbox = await createReleaseSandbox()

    sandbox.generate('--write')
    const [manifest, registry] = await Promise.all([
      sandbox.read('current-manifest.json'),
      sandbox.read('snapshot-registry.json')
    ])
    sandbox.generate('--release', 'v1.4.156')

    // The cut records provenance for bytes that are already committed, so a
    // version-only cut can never rewrite a shipped identity.
    expect(JSON.parse(await sandbox.read('release-mapping.json')).releases).toEqual([
      { appVersion: '1.4.156', skills: { demo: 1 } }
    ])
    expect(await sandbox.read('current-manifest.json')).toBe(manifest)
    expect(await sandbox.read('snapshot-registry.json')).toBe(registry)

    // Bytes that changed since the last regeneration would make the row name a
    // revision this tag does not ship — refuse rather than record it.
    await sandbox.editSkill('edited after the last regeneration\n')
    expect(() => sandbox.generate('--release', '1.4.157')).toThrow(
      /Generated skill artifacts are stale/
    )
    expect(JSON.parse(await sandbox.read('release-mapping.json')).releases).toHaveLength(1)
  })

  it('freezes a revision once a release records it, and only until then', async () => {
    const sandbox = await createReleaseSandbox()
    const demoSnapshots = async () =>
      JSON.parse(await sandbox.read('snapshot-registry.json')).skills.demo

    sandbox.generate('--write')
    const unreleased = (await demoSnapshots())[0].packageDigest

    // Nothing has shipped revision 1 yet, so re-deriving it over new bytes is
    // correct: the tail floats until a release names it.
    await sandbox.editSkill('about to ship\n')
    sandbox.generate('--write')
    const shipped = await demoSnapshots()
    expect(shipped).toHaveLength(1)
    expect(shipped[0].packageDigest).not.toBe(unreleased)

    sandbox.generate('--release', '1.4.156')

    // The cut named revision 1, so the next change appends revision 2 instead of
    // rebuilding revision 1. Installs carrying the shipped digest keep matching a
    // known snapshot — without the ledger row they would match nothing.
    await sandbox.editSkill('changed again after the cut\n')
    sandbox.generate('--write')
    const frozen = await demoSnapshots()
    expect(frozen).toHaveLength(2)
    expect(frozen[0]).toEqual(shipped[0])
    expect(frozen[1].releaseRevision).toBe(2)
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
    // Finder writes .DS_Store into any browsed folder, and it is gitignored — so without
    // this the committed artifacts read as stale and lint fails for that developer, while
    // the scanner would have no snapshot a real install could match.
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
    // Only plain files are OS-authored, so a subtree behind one of these names is real
    // content that must stay in the manifest instead of shipping unrecorded.
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

  // Why: the predicate is hand-copied from the scanner, and an asymmetric skip is worse than
  // no skip — one side would bake in content the other can never observe, leaving every
  // install permanently unrecognized. Compared through both walkers so ordering and the
  // case-fold map are covered too, not just the name test.
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

  it('computes the same Git tree identity as Git', async () => {
    const packageRoot = path.resolve('skills', 'orca-cli')
    const files = await collectPackageFiles(packageRoot)
    const expected = execFileSync('git', ['ls-tree', 'HEAD:skills', 'orca-cli'], {
      encoding: 'utf8'
    })
      .trim()
      .split(/\s+/)[2]

    expect(gitTreeSha(files)).toBe(expected)
  })

  it('matches Git when a directory and file share a name prefix', async () => {
    const packageRoot = await createPackage()
    await mkdir(path.join(packageRoot, 'sub'))
    await writeFile(path.join(packageRoot, 'sub', 'inner.txt'), 'nested\n')
    await writeFile(path.join(packageRoot, 'sub.md'), 'sibling\n')
    const files = await collectPackageFiles(packageRoot)
    execFileSync('git', ['init', '--quiet'], { cwd: packageRoot })
    execFileSync('git', ['add', '-A'], { cwd: packageRoot })
    const expected = execFileSync('git', ['write-tree'], {
      cwd: packageRoot,
      encoding: 'utf8'
    }).trim()

    expect(gitTreeSha(files)).toBe(expected)
  })

  // Why: every step in the cut job shares one workspace and one index, so any of
  // them can stage the content-addressed artifacts and the bump step's own commit
  // then carries them into the tag. Grepping the workflow cannot see a path built
  // from an env var, a composite action, or concatenation, so the cut asserts its
  // own index before committing; this test pins that guard and adds a tripwire
  // for the literal spellings.
  it('keeps the whole release-cut job off skill regeneration', async () => {
    const workflow = parse(
      await readFile(path.join(REPO_ROOT, '.github/workflows/release-cut.yml'), 'utf8')
    )
    const runSteps = workflow.jobs.cut.steps
      .filter((step) => typeof step.run === 'string')
      .map((step) => ({ name: step.name ?? '(unnamed)', run: step.run.replace(/^\s*#.*$/gm, '') }))
    const bumpStep = runSteps.find((step) => step.name === 'Bump package.json and tag')

    // The load-bearing check: whatever staged it and however the commit was
    // spelled, only these two paths may ship. Asserted on the commit rather than
    // the index because `git commit -a/-i/--only/<pathspec>` bypasses the index.
    // -F is part of the contract; without it `.` admits a path like packageXjson.
    // Flags pinned, not just the command: a `--diff-filter` slipped in here would
    // silence modifications, and dropping -m makes a merge commit report nothing.
    expect(bumpStep.run).toMatch(
      /git diff-tree --no-commit-id --name-only -r -m --first-parent HEAD\s*\|\s*grep -vxF -e 'package\.json' -e 'resources\/skills\/release-mapping\.json'/
    )
    expect(bumpStep.run.indexOf('grep -vxF')).toBeLessThan(bumpStep.run.indexOf('git tag'))
    // ...and that it aborts. A guard degraded to a warning still reads as covered.
    // The exit must be inside the guard's own block, not borrowed from a later one.
    expect(bumpStep.run).toMatch(
      /if \[\[ -n "\$committed" \]\]; then(?:(?!\bfi\b)[\s\S])*exit 1[\s\S]*?fi/
    )
    // Tripwire only. A step that merely READS this directory may be added here;
    // one that writes or stages it must not, and the guard above will reject it.
    expect(runSteps.filter((s) => /resources[/\\]skills/.test(s.run)).map((s) => s.name)).toEqual([
      'Bump package.json and tag'
    ])
    for (const step of runSteps) {
      expect(step.run, step.name).not.toMatch(/--write|generate:skill-bundle-manifest/)
    }
  })
})
