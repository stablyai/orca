import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PNPM_DIFF_FLAGS,
  assertBuildStepsAllowed,
  assertPublishedCommit,
  firstDifferenceIndex,
  formatCheckFailure,
  generatedHunks,
  normalizePnpmDiff,
  patchHash,
  pnpmDiffEnvironment,
  readLockfilePatchHash,
  sourceHunks,
  splitPatchEntries,
  stampVersionSource,
  updateLockfilePatchHash
} from './regenerate-xterm-patches.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const MANIFEST_PATH = path.join(REPO_ROOT, 'config', 'patches', 'xterm-upstream.json')
const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function createDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), 'orca-xterm-patch-'))
  temporaryDirectories.push(directory)
  return directory
}

async function writeTree(root, files) {
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, contents)
  }
}

/** The three exported diff pieces, composed the way the generator composes them. */
function diffFolders(folderA, folderB) {
  let stdout
  try {
    stdout = execFileSync('git', [...PNPM_DIFF_FLAGS, folderA, folderB], {
      encoding: 'utf8',
      env: pnpmDiffEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    if (error.status !== 1) {
      throw error
    }
    stdout = error.stdout
  }
  return normalizePnpmDiff(stdout, folderA, folderB)
}

const PRISTINE = {
  'src/Widget.ts': 'export function widget(): number {\n  return 1\n}\n',
  'src/Other.ts': 'export const other = 0\n',
  'lib/widget.js': 'function widget(){return 1}\n',
  'lib/widget.js.map': '{"version":3,"sources":["../src/Widget.ts"],"mappings":"AAAA"}\n',
  'package.json': '{\n  "name": "@scope/widget"\n}\n'
}

const PATCHED = {
  ...PRISTINE,
  'src/Widget.ts': 'export function widget(): number {\n  return 2\n}\n',
  'lib/widget.js': 'function widget(){return 2}\n',
  'lib/widget.js.map': '{"version":3,"sources":["../src/Widget.ts"],"mappings":"AAAC"}\n'
}

describe('pnpm diff format', () => {
  it('keeps the exact git flags pnpm uses, so patches survive `pnpm patch-commit`', () => {
    expect(PNPM_DIFF_FLAGS).toEqual([
      '-c',
      'core.safecrlf=false',
      'diff',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--ignore-cr-at-eol',
      '--irreversible-delete',
      '--full-index',
      '--no-index',
      '--text',
      '--no-ext-diff',
      '--no-color'
    ])
  })

  it('blanks the config-bearing environment variables', () => {
    const environment = pnpmDiffEnvironment({ PATH: '/usr/bin', HOME: '/Users/someone' })
    expect(environment).toMatchObject({
      PATH: '/usr/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: '',
      XDG_CONFIG_HOME: '',
      USERPROFILE: ''
    })
  })

  it('strips both scratch folder prefixes from headers and index lines', async () => {
    const root = await createDirectory()
    const folderA = path.join(root, 'pristine')
    const folderB = path.join(root, 'patched')
    await writeTree(folderA, PRISTINE)
    await writeTree(folderB, PATCHED)

    const patch = diffFolders(folderA, folderB)

    expect(patch).not.toContain(root)
    expect(patch).toContain('diff --git a/lib/widget.js b/lib/widget.js')
    expect(patch).toContain('--- a/src/Widget.ts')
    expect(patch).toContain('+++ b/src/Widget.ts')
  })

  it('drops a trailing no-newline marker and .DS_Store entries', () => {
    const withMarker = 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n'
    expect(normalizePnpmDiff(withMarker, '/a', '/b')).toBe(
      'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n'
    )

    const withJunk = [
      'diff --git a/.DS_Store b/.DS_Store\n',
      'index 000..111\n',
      'Binary files differ\n',
      'diff --git a/lib/x.js b/lib/x.js\n',
      '@@ -1 +1 @@\n-a\n+b\n'
    ].join('')
    expect(normalizePnpmDiff(withJunk, '/a', '/b')).toBe(
      'diff --git a/lib/x.js b/lib/x.js\n@@ -1 +1 @@\n-a\n+b\n'
    )
  })
})

describe('patch entry splitting', () => {
  it('separates hand-edited source hunks from generated bundle hunks', async () => {
    const root = await createDirectory()
    const folderA = path.join(root, 'pristine')
    const folderB = path.join(root, 'patched')
    await writeTree(folderA, PRISTINE)
    await writeTree(folderB, PATCHED)
    const patch = diffFolders(folderA, folderB)

    expect(splitPatchEntries(patch).map((entry) => entry.path)).toEqual([
      'lib/widget.js',
      'lib/widget.js.map',
      'src/Widget.ts'
    ])
    expect(splitPatchEntries(sourceHunks(patch)).map((entry) => entry.path)).toEqual([
      'src/Widget.ts'
    ])
    expect(splitPatchEntries(generatedHunks(patch, ['lib/'])).map((entry) => entry.path)).toEqual([
      'lib/widget.js',
      'lib/widget.js.map'
    ])
  })

  it('rejects renames rather than emitting a header it cannot round-trip', () => {
    expect(() => splitPatchEntries('diff --git a/old.ts b/new.ts\n')).toThrow(
      /renames are not supported/
    )
  })

  it('concatenating the two halves reproduces the whole patch', async () => {
    const root = await createDirectory()
    const folderA = path.join(root, 'pristine')
    const folderB = path.join(root, 'patched')
    await writeTree(folderA, PRISTINE)
    await writeTree(folderB, PATCHED)
    const patch = diffFolders(folderA, folderB)

    expect(generatedHunks(patch, ['lib/']) + sourceHunks(patch)).toBe(patch)
  })
})

describe('round-trip stability', () => {
  it('re-diffing an applied patch yields the identical patch', async () => {
    const root = await createDirectory()
    const folderA = path.join(root, 'pristine')
    const folderB = path.join(root, 'patched')
    await writeTree(folderA, PRISTINE)
    await writeTree(folderB, PATCHED)
    const patch = diffFolders(folderA, folderB)

    const replay = path.join(root, 'replay')
    await writeTree(replay, PRISTINE)
    const patchFile = path.join(root, 'round-trip.patch')
    await writeFile(patchFile, patch)
    execFileSync('git', ['apply', '-p1', '--whitespace=nowarn', patchFile], { cwd: replay })

    expect(await readFile(path.join(replay, 'lib/widget.js'), 'utf8')).toBe(
      PATCHED['lib/widget.js']
    )
    expect(diffFolders(folderA, replay)).toBe(patch)
  })

  it('applying only the source half leaves the bundle untouched', async () => {
    const root = await createDirectory()
    const folderA = path.join(root, 'pristine')
    const folderB = path.join(root, 'patched')
    await writeTree(folderA, PRISTINE)
    await writeTree(folderB, PATCHED)
    const patchFile = path.join(root, 'src.patch')
    await writeFile(patchFile, sourceHunks(diffFolders(folderA, folderB)))

    const replay = path.join(root, 'replay')
    await writeTree(replay, PRISTINE)
    execFileSync('git', ['apply', '-p1', '--whitespace=nowarn', patchFile], { cwd: replay })

    expect(await readFile(path.join(replay, 'src/Widget.ts'), 'utf8')).toBe(
      PATCHED['src/Widget.ts']
    )
    expect(await readFile(path.join(replay, 'lib/widget.js'), 'utf8')).toBe(
      PRISTINE['lib/widget.js']
    )
  })
})

describe('manifest guards', () => {
  const packageEntry = { name: '@xterm/xterm', version: '6.1.0-beta.287' }
  const commit = '53a98a720ae4a973e384fa2440880d09537132f3'

  it('accepts a tarball that names the pinned commit', () => {
    const published = { version: '6.1.0-beta.287', commit }
    expect(() => assertPublishedCommit(published, packageEntry, commit)).not.toThrow()
  })

  it('fails when a version bump moved the upstream commit', () => {
    const published = { version: '6.1.0-beta.287', commit: 'f'.repeat(40) }
    expect(() => assertPublishedCommit(published, packageEntry, commit)).toThrow(
      /was published from commit[\s\S]*Update upstream\.commit/
    )
  })

  it('fails when the registry serves a different version than the manifest pins', () => {
    const published = { version: '6.1.0-beta.288', commit }
    expect(() => assertPublishedCommit(published, packageEntry, commit)).toThrow(/registry served/)
  })

  it('fails when the tarball carries no commit stamp at all', () => {
    expect(() =>
      assertPublishedCommit({ version: '6.1.0-beta.287' }, packageEntry, commit)
    ).toThrow(/\(absent\)/)
  })

  it('refuses a build step that would de-minify the bundle', () => {
    const manifest = {
      forbiddenBuildScripts: { why: 'dev esbuild', scripts: ['setup'] },
      packages: [
        {
          name: '@xterm/xterm',
          build: [
            { cwd: '.', command: 'npm', args: ['run', 'setup'] },
            { cwd: '.', command: 'npm', args: ['run', 'package'] }
          ]
        }
      ]
    }
    expect(() => assertBuildStepsAllowed(manifest)).toThrow(/`npm run setup` is forbidden/)
  })

  it('stamps the published version into the version source', () => {
    const source = "export const XTERM_VERSION = '6.0.0';\n"
    expect(stampVersionSource(source, '6.1.0-beta.287')).toBe(
      "export const XTERM_VERSION = '6.1.0-beta.287';\n"
    )
    expect(() => stampVersionSource('export const OTHER = 1\n', '6.1.0')).toThrow(/XTERM_VERSION/)
  })
})

describe('lockfile coupling', () => {
  const lockfile = [
    'patchedDependencies:',
    "  '@xterm/xterm@6.1.0-beta.287':",
    `    hash: ${'0'.repeat(64)}`,
    '    path: config/patches/@xterm__xterm@6.1.0-beta.287.patch',
    '  node-pty@1.1.0:',
    `    hash: ${'1'.repeat(64)}`,
    '    path: config/patches/node-pty@1.1.0.patch',
    ''
  ].join('\n')

  it('hashes the patch the way pnpm keys the store directory', () => {
    expect(patchHash('diff --git a/x b/x\n')).toBe(
      createHash('sha256').update('diff --git a/x b/x\n').digest('hex')
    )
  })

  it('reads quoted and unquoted package keys', () => {
    expect(readLockfilePatchHash(lockfile, '@xterm/xterm@6.1.0-beta.287')).toBe('0'.repeat(64))
    expect(readLockfilePatchHash(lockfile, 'node-pty@1.1.0')).toBe('1'.repeat(64))
  })

  it('rewrites only the targeted entry', () => {
    const updated = updateLockfilePatchHash(lockfile, '@xterm/xterm@6.1.0-beta.287', 'a'.repeat(64))
    expect(readLockfilePatchHash(updated, '@xterm/xterm@6.1.0-beta.287')).toBe('a'.repeat(64))
    expect(readLockfilePatchHash(updated, 'node-pty@1.1.0')).toBe('1'.repeat(64))
    expect(updated.split('\n')).toHaveLength(lockfile.split('\n').length)
  })

  it('fails loudly when the package is not patched at all', () => {
    expect(() => readLockfilePatchHash(lockfile, '@xterm/addon-webgl@0.20.0-beta.286')).toThrow(
      /no patchedDependencies entry/
    )
  })
})

describe('check-mode reporting', () => {
  it('points at the source patch instead of the bundle', () => {
    const message = formatCheckFailure({
      name: '@xterm/xterm',
      patchPath: 'config/patches/@xterm__xterm@6.1.0-beta.287.patch',
      committed: 'diff --git a/lib/x.js b/lib/x.js\n@@ -1 +1 @@\n-a\n+b\n',
      regenerated: 'diff --git a/lib/x.js b/lib/x.js\n@@ -1 +1 @@\n-a\n+c\n'
    })
    expect(message).toContain('Do not edit them')
    expect(message).toContain('--write')
    expect(message).toContain('docs/reference/xterm-patch-regeneration.md')
    expect(message).toContain('files [lib/x.js]')
  })

  it('locates the first differing character', () => {
    expect(firstDifferenceIndex('abc', 'abd')).toBe(2)
    expect(firstDifferenceIndex('abc', 'abc')).toBe(-1)
    expect(firstDifferenceIndex('abc', 'abcd')).toBe(3)
  })
})

// These run without network or a build, so ordinary `pnpm test` catches the two
// desyncs that would otherwise only surface in the heavy xterm_patch_sync job.
describe('committed xterm patch artifacts', () => {
  it('records the lockfile hash pnpm derives from the patch file', async () => {
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
    const lockfile = await readFile(path.join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8')
    for (const packageEntry of manifest.packages) {
      const patch = await readFile(path.join(REPO_ROOT, packageEntry.patch), 'utf8')
      const key = `${packageEntry.name}@${packageEntry.version}`
      expect(readLockfilePatchHash(lockfile, key)).toBe(patchHash(patch))
    }
  })

  it('keeps the source patch equal to the source half of the full patch', async () => {
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
    for (const packageEntry of manifest.packages) {
      const patch = await readFile(path.join(REPO_ROOT, packageEntry.patch), 'utf8')
      const source = await readFile(path.join(REPO_ROOT, packageEntry.sourcePatch), 'utf8')
      expect(source).toBe(sourceHunks(patch))
      expect(generatedHunks(patch, packageEntry.generatedPaths)).not.toBe('')
    }
  })

  it('pins a full upstream commit and a buildable package entry', async () => {
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
    expect(manifest.upstream.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(manifest.packages.length).toBeGreaterThan(0)
    expect(() => assertBuildStepsAllowed(manifest)).not.toThrow()
  })
})
