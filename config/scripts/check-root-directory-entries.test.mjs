import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')
const guardScript = join(projectDir, '.github/scripts/check-root-directory-entries.mjs')
const tempDirs = []

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-root-directory-guard-'))
  tempDirs.push(root)
  git(root, ['init', '--quiet'])
  git(root, ['config', 'user.email', 'root-directory-guard-test@example.com'])
  git(root, ['config', 'user.name', 'Root Directory Guard Test'])
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(join(root, 'config', 'base.txt'), 'base\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '--quiet', '-m', 'base'])
  return { root, base: git(root, ['rev-parse', 'HEAD']) }
}

function commitFiles(root, files) {
  for (const [relativePath, contents] of files) {
    const target = join(root, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
  git(root, ['add', '-A'])
  git(root, ['commit', '--quiet', '-m', 'head'])
  return git(root, ['rev-parse', 'HEAD'])
}

// Why: a root entry name can be bytes no filesystem here accepts (APFS rejects
// invalid UTF-8), so build the tree in the object database instead of on disk.
// git ls-tree -z emits exactly the record format git mktree -z reads back.
function commitRawEntries(root, parent, entries) {
  const parentTree = execFileSync('git', ['ls-tree', '-z', parent], { cwd: root })
  const records = entries.map((name) => {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: root,
      encoding: 'utf8',
      input: 'too prominent\n'
    }).trim()
    return Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), name, Buffer.from([0])])
  })
  const tree = execFileSync('git', ['mktree', '-z'], {
    cwd: root,
    encoding: 'utf8',
    input: Buffer.concat([parentTree, ...records])
  }).trim()
  return execFileSync('git', ['commit-tree', tree, '-p', parent, '-m', 'head'], {
    cwd: root,
    encoding: 'utf8'
  }).trim()
}

function runGuard({ root, base, head }) {
  return runGuardArgs(root, [base, head])
}

function runGuardArgs(root, args) {
  return spawnSync(process.execPath, [guardScript, ...args], {
    cwd: root,
    encoding: 'utf8'
  })
}

function runGuardBytes({ root, base, head }) {
  return spawnSync(process.execPath, [guardScript, base, head], { cwd: root })
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true })
  }
})

describe('root directory guard', () => {
  it('allows additions inside an existing top-level directory', () => {
    const fixture = makeFixture()
    const head = commitFiles(fixture.root, [['config/new.txt', 'nested\n']])

    const result = runGuard({ ...fixture, head })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('no new root-level files or folders')
  })

  it('rejects a new root-level file with the landing-page message', () => {
    const fixture = makeFixture()
    const head = commitFiles(fixture.root, [['new-root.md', 'too prominent\n']])

    const result = runGuard({ ...fixture, head })
    const output = `${result.stdout}\n${result.stderr}`

    expect(result.status).toBe(1)
    expect(output).toContain('bloat the GitHub landing page')
    expect(output).toContain('new-root.md')
  })

  it('rejects a new top-level directory', () => {
    const fixture = makeFixture()
    const head = commitFiles(fixture.root, [['new-folder/file.txt', 'too prominent\n']])

    const result = runGuard({ ...fixture, head })
    const output = `${result.stdout}\n${result.stderr}`

    expect(result.status).toBe(1)
    expect(output).toContain('new-folder')
  })

  // Why: git escapes odd paths unless it is read NUL-delimited, so dropping -z
  // (or decoding the bytes wrong) reports a mangled name nobody can act on.
  it.skipIf(process.platform === 'win32')('reports a blocked entry byte-for-byte', () => {
    const awkwardName = '日本 root file\nwith newline.txt'
    const fixture = makeFixture()
    const head = commitFiles(fixture.root, [[awkwardName, 'too prominent\n']])

    const result = runGuard({ ...fixture, head })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain(awkwardName)
  })

  // Why: decoding git's output as UTF-8 rewrites every invalid byte to U+FFFD, so
  // the name the guard prints is not the name anyone has to rename.
  it('reports an entry whose name is not valid UTF-8 byte-for-byte', () => {
    const rawName = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('-raw.txt')])
    const fixture = makeFixture()
    const head = commitRawEntries(fixture.root, fixture.base, [rawName])

    const result = runGuardBytes({ ...fixture, head })

    expect(result.status).toBe(1)
    expect(result.stdout.includes(rawName)).toBe(true)
  })

  // Why: U+FFFD is not injective, so two different invalid names decode to the
  // same string and a new root entry gets waved through as pre-existing.
  it('does not confuse two different invalid UTF-8 names for the same entry', () => {
    const fixture = makeFixture()
    const base = commitRawEntries(fixture.root, fixture.base, [
      Buffer.concat([Buffer.from([0xc0, 0x80]), Buffer.from('.txt')])
    ])
    const head = commitRawEntries(fixture.root, fixture.base, [
      Buffer.concat([Buffer.from([0xc0, 0x81]), Buffer.from('.txt')])
    ])

    const result = runGuardBytes({ root: fixture.root, base, head })

    expect(result.status).toBe(1)
    expect(result.stdout.toString('latin1')).not.toContain('guard passed')
  })

  // Why: the runner trims leading spaces before matching '::', so an indented
  // entry name still reaches the workflow-command parser and can forge output.
  it('prints blocked entries with workflow-command parsing disabled', () => {
    const fixture = makeFixture()
    const forgedName = '::error title=forged::injected\n::warning::second line.txt'
    const head = commitRawEntries(fixture.root, fixture.base, [Buffer.from(forgedName)])

    const result = runGuard({ ...fixture, head })
    const lines = result.stdout.split('\n')
    const stopIndex = lines.findIndex((line) => line.startsWith('::stop-commands::'))
    const resumeToken = lines[stopIndex]?.slice('::stop-commands::'.length)
    const resumeIndex = lines.indexOf(`::${resumeToken}::`)
    const escaped = lines.filter(
      (line, index) =>
        (index < stopIndex || index > resumeIndex) && line.trimStart().startsWith('::')
    )

    expect(result.status).toBe(1)
    expect(resumeToken).toMatch(/^[\da-f-]{36}$/)
    expect(stopIndex).toBeLessThan(resumeIndex)
    // Why: the guard's own annotation is the only line the runner may act on.
    expect(escaped).toHaveLength(1)
    expect(escaped[0]).toContain('Root-level additions blocked')
    expect(lines.slice(stopIndex, resumeIndex).join('\n')).toContain(forgedName)
  })

  it('exits 2 with usage when the two shas are not both supplied', () => {
    const fixture = makeFixture()

    const result = runGuardArgs(fixture.root, [fixture.base])

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('<base-sha> <head-sha>')
  })

  it('fails loudly instead of passing when a sha does not resolve', () => {
    const fixture = makeFixture()

    const result = runGuardArgs(fixture.root, [
      fixture.base,
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    ])

    // Why: git's own exit status, not node's. An unhandled throw is also non-zero,
    // so assert the status and the absent stack trace or the guard's error
    // handling can be deleted without a test noticing.
    expect(result.status).toBe(128)
    expect(result.stderr).not.toContain('node:internal')
    expect(result.stdout).not.toContain('guard passed')
  })

  it('is wired into the PR verify gate', () => {
    const workflow = parse(readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8'))
    const guardJob = workflow.jobs.root_directory_guard
    const guardStep = guardJob.steps.find(
      (step) => step.name === 'Reject new root-level files and folders'
    )

    expect(guardJob.name).toBe('root directory guard')
    expect(guardJob.steps[0].with['fetch-depth']).toBe(0)
    expect(guardStep.run).toContain('node .github/scripts/check-root-directory-entries.mjs')
    expect(workflow.jobs.verify.needs).toContain('root_directory_guard')
  })
})
