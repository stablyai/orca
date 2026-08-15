import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { listPullFiles, nextLink } from '../../.github/scripts/pr-test-loc-summary.mjs'
import {
  LOC_HANDS_OFF_COMMENT,
  isTestPath,
  mergeLocBlock,
  renderLocBlock,
  sumChangedFiles
} from '../../.github/scripts/pr-test-loc-table.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const locScript = join(projectDir, '.github/scripts/pr-test-loc-summary.mjs')
const tempDirs = []

function runLoc(args, { env } = {}) {
  return spawnSync(process.execPath, [locScript, ...args], {
    cwd: projectDir,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true })
  }
})

describe('PR test LoC summary', () => {
  it('classifies colocated tests and e2e/tests directories', () => {
    expect(isTestPath('src/main/foo.test.ts')).toBe(true)
    expect(isTestPath('src/main/foo.spec.tsx')).toBe(true)
    expect(isTestPath('src/e2e/login.ts')).toBe(true)
    expect(isTestPath('tests/tools/probe.mjs')).toBe(true)
    expect(isTestPath('src/main/foo-test-setup.ts')).toBe(false)
    expect(isTestPath('src/main/foo.ts')).toBe(false)
  })

  it('sums GitHub pull-file additions and deletions', () => {
    const totals = sumChangedFiles([
      { filename: 'src/app.ts', additions: 4, deletions: 1 },
      { filename: 'src/app.test.ts', additions: 12, deletions: 3 },
      { filename: 'icon.png', additions: 0, deletions: 0 }
    ])

    expect(totals).toEqual({
      test: { files: 1, added: 12, deleted: 3 },
      nonTest: { files: 2, added: 4, deleted: 1 }
    })
  })

  it('reads the next page from a GitHub Link header', () => {
    expect(
      nextLink(
        '<https://api.github.com/repos/stablyai/orca/pulls/1/files?page=2>; rel="next", <https://api.github.com/repos/stablyai/orca/pulls/1/files?page=3>; rel="last"'
      )
    ).toBe('https://api.github.com/repos/stablyai/orca/pulls/1/files?page=2')
    expect(
      nextLink('<https://api.github.com/repos/stablyai/orca/pulls/1/files?page=1>; rel="prev"')
    ).toBe(undefined)
  })

  it('paginates pull files until Link rel=next is gone', async () => {
    const pages = {
      'https://api.github.com/repos/stablyai/orca/pulls/9/files?per_page=100': {
        body: [{ filename: 'src/app.ts', additions: 2, deletions: 0 }],
        link: '<https://api.github.com/repos/stablyai/orca/pulls/9/files?page=2>; rel="next"'
      },
      'https://api.github.com/repos/stablyai/orca/pulls/9/files?page=2': {
        body: [{ filename: 'src/app.test.ts', additions: 5, deletions: 1 }],
        link: null
      }
    }

    const files = await listPullFiles({
      owner: 'stablyai',
      repo: 'orca',
      pullNumber: 9,
      token: 'test-token',
      fetchImpl: async (url) => {
        const page = pages[url]
        if (page == null) {
          throw new Error(`unexpected url ${url}`)
        }
        return {
          ok: true,
          json: async () => page.body,
          headers: { get: (name) => (name === 'link' ? page.link : null) }
        }
      }
    })

    expect(sumChangedFiles(files)).toEqual({
      test: { files: 1, added: 5, deleted: 1 },
      nonTest: { files: 1, added: 2, deleted: 0 }
    })
  })

  it('replaces an existing header and prepends when missing', () => {
    const totals = {
      test: { files: 1, added: 2, deleted: 1 },
      nonTest: { files: 1, added: 4, deleted: 0 }
    }
    const block = renderLocBlock(totals)

    expect(block).toContain(LOC_HANDS_OFF_COMMENT)
    expect(block).toContain('| Test | 1 | +2 | −1 | +1 |')
    expect(block).toContain('| Prod | 1 | +4 | 0 | +4 |')
    expect(block).toContain('| Total | 2 | +6 | −1 | +5 |')
    expect(mergeLocBlock('## ELI5\n\nHello\n', totals)).toBe(`${block}\n\n## ELI5\n\nHello\n`)
    expect(mergeLocBlock(`${block}\n\n## ELI5\n`, totals)).toBe(`${block}\n\n## ELI5\n`)
    expect(
      mergeLocBlock(
        '<!-- orca-pr-loc -->\n**LoC** · test **+1 / −0**\n<!-- /orca-pr-loc -->\n\n## ELI5\n',
        totals
      )
    ).toBe(`${block}\n\n## ELI5\n`)
  })

  it('counts and merges from a files JSON fixture', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-pr-test-loc-'))
    tempDirs.push(root)
    const filesPath = join(root, 'files.json')
    const bodyPath = join(root, 'body.md')
    writeFileSync(
      filesPath,
      JSON.stringify([
        { filename: 'src/app.ts', additions: 2, deletions: 0 },
        { filename: 'src/app.test.ts', additions: 6, deletions: 1 }
      ])
    )
    writeFileSync(bodyPath, '## ELI5\n\nHello\n')

    const result = runLoc(['--files-json', filesPath, '--merge-body', bodyPath])

    expect(result.status).toBe(0)
    expect(result.stdout.startsWith('<!-- orca-pr-loc -->')).toBe(true)
    expect(result.stdout).toContain(LOC_HANDS_OFF_COMMENT)
    expect(result.stdout).toContain('| Test | 1 | +6 | −1 | +5 |')
    expect(result.stdout).toContain('| Prod | 1 | +2 | 0 | +2 |')
    expect(result.stdout).toContain('| Total | 2 | +8 | −1 | +7 |')
    expect(result.stdout).toContain('## ELI5\n\nHello\n')
    expect(result.stdout.match(/<!-- orca-pr-loc -->/g)).toHaveLength(1)
  })

  it('exits 2 with usage when no PR or files JSON is supplied', () => {
    const result = runLoc([])

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('--from-pr')
  })

  it('is a no-checkout GitHub-hosted PR workflow', () => {
    const workflow = parse(
      readFileSync(join(projectDir, '.github/workflows/pr-test-loc.yml'), 'utf8')
    )
    const locJob = workflow.jobs.loc
    const serialized = JSON.stringify(workflow)

    expect(locJob['runs-on']).toBe('ubuntu-latest')
    expect(locJob.steps).toHaveLength(1)
    expect(locJob.steps[0].run).toContain('gh api')
    expect(locJob.steps[0].run).toContain('pr-test-loc-table.mjs')
    expect(locJob.steps[0].run).toContain('pr-test-loc-summary.mjs')
    expect(locJob.steps[0].run).toContain('--update-pr')
    expect(workflow.permissions['pull-requests']).toBe('write')
    expect(serialized).not.toContain('actions/checkout')
    expect(serialized).not.toContain('self-hosted')
  })
})
