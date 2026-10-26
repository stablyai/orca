import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
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

// Build raw-byte names in Git objects: APFS rejects invalid UTF-8. ls-tree -z records round-trip through mktree -z.
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

  it('allows the reviewed cloud workspace directory', () => {
    const fixture = makeFixture()
    const head = commitFiles(fixture.root, [['cloud/package.json', '{}\n']])

    const result = runGuard({ ...fixture, head })

    expect(result.status).toBe(0)
  })

  it('allows the reviewed repository OpenCode permission config', () => {
    const fixture = makeFixture()
    const head = commitFiles(fixture.root, [
      ['opencode.json', '{"permission":{"*":{"*":"allow"}}}\n']
    ])

    const result = runGuard({ ...fixture, head })

    expect(result.status).toBe(0)
  })

  it('rejects a new top-level directory', () => {
    const fixture = makeFixture()
    const head = commitFiles(fixture.root, [['new-folder/file.txt', 'too prominent\n']])

    const result = runGuard({ ...fixture, head })
    const output = `${result.stdout}\n${result.stderr}`

    expect(result.status).toBe(1)
    expect(output).toContain('new-folder')
  })

  // Without NUL delimiting, Git escapes odd paths into names users cannot act on.
  it.skipIf(process.platform === 'win32')('reports a blocked entry byte-for-byte', () => {
    const awkwardName = '日本 root file\nwith newline.txt'
    const fixture = makeFixture()
    const head = commitFiles(fixture.root, [[awkwardName, 'too prominent\n']])

    const result = runGuard({ ...fixture, head })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain(awkwardName)
  })

  // UTF-8 decoding replaces invalid bytes with U+FFFD, losing the name that needs renaming.
  it('reports an entry whose name is not valid UTF-8 byte-for-byte', () => {
    const rawName = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('-raw.txt')])
    const fixture = makeFixture()
    const head = commitRawEntries(fixture.root, fixture.base, [rawName])

    const result = runGuardBytes({ ...fixture, head })

    expect(result.status).toBe(1)
    expect(result.stdout.includes(rawName)).toBe(true)
  })

  // Distinct invalid names collapse to U+FFFD, allowing new entries to masquerade as existing ones.
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

  // Runner trims spaces before ::, so indented names can still forge workflow commands.
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

    // Assert Git’s status and no stack trace: an unhandled Node throw is also nonzero and could hide broken error handling.
    expect(result.status).toBe(128)
    expect(result.stderr).not.toContain('node:internal')
    expect(result.stdout).not.toContain('guard passed')
  })

  it('is wired into the ready PR verify gate', () => {
    const workflow = parse(readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8'))
    const guardJob = workflow.jobs.code_paths
    const guardStep = guardJob.steps.find(
      (step) => step.name === 'Reject new root-level files and folders'
    )

    // Only draft PRs skip the guard; verify skips with it, so no draft reports a result.
    const runsFor = (expression, draft) =>
      runInNewContext(expression.replace(/^\$\{\{(.*)\}\}$/s, '$1'), {
        github: { event_name: 'pull_request', event: { pull_request: { draft } } },
        cancelled: () => false
      })
    expect(runsFor(guardJob.if, false)).toBe(true)
    expect(runsFor(guardJob.if, true)).toBe(false)
    expect(runsFor(workflow.jobs.verify.if, true)).toBe(false)
    expect(guardStep.if).toBeUndefined()
    // Merge-ref comparison needs both parents (depth >=2); depth 1 makes HEAD^1 unreachable and every guard fail closed.
    expect(guardJob.steps[0].with['fetch-depth']).toBeGreaterThanOrEqual(2)
    expect(guardStep.run).toContain('node .github/scripts/check-root-directory-entries.mjs')
    // Read base from merge ref; shallow checkout may not resolve event-payload ancestry.
    expect(guardStep.run).toContain('git-pull-request-diff-base.mjs')
    expect(workflow.jobs.verify.needs).toContain('code_paths')
  })
})
