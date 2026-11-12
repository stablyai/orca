import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateReleaseTag } from './validate-release-tag.mjs'

function git(cwd, ...args) {
  return execFileSync(
    'git',
    [
      '-c',
      'commit.gpgsign=false',
      '-c',
      'tag.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim()
}

function fixture(run, version = '1.4.257') {
  const root = mkdtempSync(join(tmpdir(), 'orca-release-tag-'))
  try {
    const source = join(root, 'source')
    git(root, 'init', '--initial-branch=main', source)
    git(source, 'config', 'user.name', 'Release Test')
    git(source, 'config', 'user.email', 'release@example.com')
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'orca', version }))
    git(source, 'add', 'package.json')
    git(source, 'commit', '-m', 'source')
    const sourceSha = git(source, 'rev-parse', 'HEAD')
    const bundle = join(root, 'release.bundle')
    const destination = join(root, 'trusted')
    git(root, 'clone', '--no-local', '--depth=1', source, destination)
    return run({ root, source, sourceSha, bundle, destination })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function release(
  f,
  {
    extra = false,
    packageMutation = false,
    empty = false,
    lightweight = false,
    nested = false
  } = {}
) {
  if (!empty) {
    writeFileSync(
      join(f.source, 'package.json'),
      JSON.stringify({ name: packageMutation ? 'another-product' : 'orca', version: '1.4.258' })
    )
  }
  if (extra) {
    writeFileSync(join(f.source, 'unexpected.txt'), 'unexpected release bytes')
  }
  git(f.source, 'add', '.')
  git(f.source, 'commit', '--allow-empty', '-m', 'release')
  const sha = git(f.source, 'rev-parse', 'HEAD')
  if (nested) {
    git(f.source, 'tag', '-a', 'inner', '-m', 'inner')
  }
  git(
    f.source,
    'tag',
    ...(lightweight
      ? ['v1.4.258']
      : ['-a', 'v1.4.258', ...(nested ? ['inner'] : []), '-m', 'v1.4.258'])
  )
  git(f.source, 'bundle', 'create', f.bundle, 'refs/tags/v1.4.258', `^${f.sourceSha}`)
  return sha
}

describe('validated release object transfer', () => {
  it('publishes the annotated version-only child of the original pin after its branch moves', () =>
    fixture((f) => {
      const sha = release(f)
      writeFileSync(join(f.source, 'later.txt'), 'the source branch moved')
      git(f.source, 'add', '.')
      git(f.source, 'commit', '-m', 'later branch tip')
      const result = validateReleaseTag({
        cwd: f.destination,
        sourceSha: f.sourceSha,
        tag: 'v1.4.258',
        bundle: f.bundle,
        version: '1.4.258'
      })
      expect(result).toEqual({
        tag: 'v1.4.258',
        release_sha: sha,
        tag_object_sha: git(f.source, 'rev-parse', 'v1.4.258'),
        ships_orcad_template: 'false'
      })
    }))

  it('accepts the existing empty version-commit recovery shape', () =>
    fixture((f) => {
      const sha = release(f, { empty: true })
      expect(
        validateReleaseTag({
          cwd: f.destination,
          sourceSha: f.sourceSha,
          tag: 'v1.4.258',
          bundle: f.bundle,
          kind: 'patch'
        }).release_sha
      ).toBe(sha)
    }, '1.4.258'))

  it.each([
    ['extra shipped path', { extra: true }, 'changes more than package.json'],
    ['another package property', { packageMutation: true }, 'changes more than its version'],
    ['lightweight new tag', { lightweight: true }, 'Command failed'],
    ['nested annotation', { nested: true }, 'directly annotate']
  ])('rejects %s before publication', (_name, options, message) =>
    fixture((f) => {
      release(f, options)
      expect(() =>
        validateReleaseTag({
          cwd: f.destination,
          sourceSha: f.sourceSha,
          tag: 'v1.4.258',
          bundle: f.bundle,
          kind: 'patch'
        })
      ).toThrow(message)
    })
  )

  it('rejects a substituted source even when preparation claimed that source', () =>
    fixture((f) => {
      git(f.source, 'commit', '--allow-empty', '-m', 'substituted parent')
      release(f)
      expect(() =>
        validateReleaseTag({
          cwd: f.destination,
          sourceSha: f.sourceSha,
          tag: 'v1.4.258',
          bundle: f.bundle,
          kind: 'patch'
        })
      ).toThrow('another source')
    }))

  it('rejects a different explicit version', () =>
    fixture((f) => {
      release(f)
      expect(() =>
        validateReleaseTag({
          cwd: f.destination,
          sourceSha: f.sourceSha,
          tag: 'v1.4.258',
          bundle: f.bundle,
          version: '1.4.259'
        })
      ).toThrow('requested version')
    }))

  it('retains legacy lightweight remote-tag recovery without a new push', () =>
    fixture((f) => {
      git(f.source, 'tag', 'v1.4.258')
      expect(
        validateReleaseTag({
          cwd: f.destination,
          sourceSha: f.sourceSha,
          tag: 'v1.4.258',
          recovery: true
        }).release_sha
      ).toBe(f.sourceSha)
    }))

  it.each(['true', 'false'])(
    'keeps original dry-run=%s and no-cut outputs safe against prepared claims',
    (dryRun) =>
      fixture((f) => {
        const output = join(f.root, 'outputs')
        execFileSync(
          process.execPath,
          [fileURLToPath(new URL('./validate-release-tag.mjs', import.meta.url))],
          {
            cwd: f.destination,
            env: {
              ...process.env,
              GITHUB_OUTPUT: output,
              DRY_RUN: dryRun,
              SOURCE_SHA: f.sourceSha,
              NEW_TAG: dryRun === 'true' ? 'v9.9.9' : '',
              RECOVERED_TAG: '',
              LATEST_PUBLISHED_RC: ''
            }
          }
        )
        expect(readFileSync(output, 'utf8')).toBe(
          'tag=\nrelease_sha=\ntag_object_sha=\nshould_release=false\nships_orcad_template=false\nlatest_published_rc_tag=\n'
        )
      })
  )
})
