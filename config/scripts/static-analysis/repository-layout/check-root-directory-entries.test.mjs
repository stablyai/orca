import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../../../..')
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

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true })
  }
})

describe('root directory guard', () => {
  // Without NUL delimiting, Git escapes odd paths into names users cannot act on.

  // UTF-8 decoding replaces invalid bytes with U+FFFD, losing the name that needs renaming.

  // Distinct invalid names collapse to U+FFFD, allowing new entries to masquerade as existing ones.

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
})
