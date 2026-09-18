import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '../..')
const trackedAuditFile = 'docs/audits/auth-filesystem-wait-retention/README.md'
const ignoredDocsScratch = 'docs/scratch/notes.md'

function gitCheckIgnore(relativePath, extraArgs = []) {
  return spawnSync('git', ['check-ignore', ...extraArgs, '--no-index', relativePath], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true
  })
}

// -v prints source:line:pattern<TAB>path; a leading ! means the path is not ignored.
function matchingIgnorePattern(result) {
  const line = result.stdout.trim().split('\n').at(-1) ?? ''
  const tab = line.lastIndexOf('\t')
  const meta = tab === -1 ? line : line.slice(0, tab)
  const colon = meta.lastIndexOf(':')
  return colon === -1 ? '' : meta.slice(colon + 1)
}

describe('docs/audits git visibility', () => {
  it('does not let docs/** swallow tracked audit evidence', () => {
    const verbose = gitCheckIgnore(trackedAuditFile, ['-v'])
    expect(matchingIgnorePattern(verbose)).toMatch(/^!docs\/audits\//)
    expect(gitCheckIgnore(trackedAuditFile).status).toBe(1)
  })

  it('still gitignores local docs outside the allow-list', () => {
    const result = gitCheckIgnore(ignoredDocsScratch, ['-v'])
    expect(result.status).toBe(0)
    expect(matchingIgnorePattern(result)).toBe('docs/**')
  })

  it('keeps default oxlint from walking audit evidence', () => {
    const config = JSON.parse(readFileSync(resolve(repoRoot, '.oxlintrc.json'), 'utf8'))
    expect(config.ignorePatterns).toContain('docs/audits/**')
  })
})
