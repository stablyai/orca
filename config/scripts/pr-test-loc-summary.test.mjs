import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  listPullFiles,
  nextLink,
  updatePullRequest
} from '../../.github/scripts/pr-test-loc-summary.mjs'
import {
  LOC_HANDS_OFF_COMMENT,
  isTestPath,
  mergeLocBlock,
  renderLocBlock,
  sumChangedFiles
} from '../../.github/scripts/pr-test-loc-table.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const locScript = join(projectDir, '.github/scripts/pr-test-loc-summary.mjs')
const locWorkflow = parse(
  readFileSync(join(projectDir, '.github/workflows/pr-test-loc.yml'), 'utf8')
)
const locJob = locWorkflow.jobs.loc
const locStep = locJob.steps[0]
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

  it('classifies __fixtures__ and __snapshots__ data of any extension', () => {
    expect(isTestPath('src/main/__fixtures__/shell-wrapper-snapshots/local-zsh-zshrc.txt')).toBe(
      true
    )
    expect(isTestPath('src/shared/__fixtures__/trace.json')).toBe(true)
    expect(isTestPath('src/main/runtime/orchestration/__snapshots__/run.test.ts.snap')).toBe(true)
    // Why: only the __-wrapped names count; a bare `fixtures` dir stays prod.
    expect(isTestPath('src/main/daemon/fixtures/ratatui-tui.py')).toBe(false)
    expect(isTestPath('src/main/my__fixtures__helper.ts')).toBe(false)
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
          throw new Error(`unexpected url ${String(url)}`)
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

  it('retries transient GitHub errors when updating the PR body', async () => {
    const responses = [
      { ok: false, status: 503, statusText: 'Service Unavailable' },
      { ok: true, status: 200, statusText: 'OK' }
    ]
    const requests = []
    const result = await updatePullRequest({
      owner: 'stablyai',
      repo: 'orca',
      pullNumber: 14656,
      token: 'test-token',
      totals: {
        test: { files: 1, added: 2, deleted: 0 },
        nonTest: { files: 0, added: 0, deleted: 0 }
      },
      fetchImpl: async (url, options) => {
        requests.push({ url, options })
        if (requests.length === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ body: '## Description\n' })
          }
        }
        return responses.shift()
      },
      sleepImpl: async () => {}
    })

    expect(result).toBe(0)
    expect(requests).toHaveLength(3)
    expect(requests[1].options.method).toBe('PATCH')
    expect(requests[2].options.method).toBe('PATCH')
  })

  it('colors added cells green and deleted or negative-net cells red', () => {
    const block = renderLocBlock({
      test: { files: 1, added: 2, deleted: 5 },
      nonTest: { files: 1, added: 0, deleted: 4 }
    })

    expect(block).toContain(
      '| Test | 1 | $\\color{#1a7f37}{\\Huge{\\mathbf{+}}}$\u200b2 | $\\color{#cf222e}{\\Huge{\\mathbf{−}}}$\u200b5 | $\\color{#cf222e}{\\Huge{\\mathbf{−}}}$\u200b3 |'
    )
    expect(block).toContain(
      '| Prod | 1 | 0 | $\\color{#cf222e}{\\Huge{\\mathbf{−}}}$\u200b4 | $\\color{#cf222e}{\\Huge{\\mathbf{−}}}$\u200b4 |'
    )
  })

  it('replaces an existing header and prepends when missing', () => {
    const totals = {
      test: { files: 1, added: 2, deleted: 1 },
      nonTest: { files: 1, added: 4, deleted: 0 }
    }
    const block = renderLocBlock(totals)

    expect(block).toContain(LOC_HANDS_OFF_COMMENT)
    expect(block).toContain(
      '| Test | 1 | $\\color{#1a7f37}{\\Huge{\\mathbf{+}}}$\u200b2 | $\\color{#cf222e}{\\Huge{\\mathbf{−}}}$\u200b1 | $\\color{#1a7f37}{\\Huge{\\mathbf{+}}}$\u200b1 |'
    )
    expect(block).toContain(
      '| Prod | 1 | $\\color{#1a7f37}{\\Huge{\\mathbf{+}}}$\u200b4 | 0 | $\\color{#1a7f37}{\\Huge{\\mathbf{+}}}$\u200b4 |'
    )
    expect(block).not.toContain('| Total |')
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
    expect(result.stdout).toContain(
      '| Test | 1 | $\\color{#1a7f37}{\\Huge{\\mathbf{+}}}$\u200b6 | $\\color{#cf222e}{\\Huge{\\mathbf{−}}}$\u200b1 | $\\color{#1a7f37}{\\Huge{\\mathbf{+}}}$\u200b5 |'
    )
    expect(result.stdout).toContain(
      '| Prod | 1 | $\\color{#1a7f37}{\\Huge{\\mathbf{+}}}$\u200b2 | 0 | $\\color{#1a7f37}{\\Huge{\\mathbf{+}}}$\u200b2 |'
    )
    expect(result.stdout).not.toContain('| Total |')
    expect(result.stdout).toContain('## ELI5\n\nHello\n')
    expect(result.stdout.match(/<!-- orca-pr-loc -->/g)).toHaveLength(1)
  })

  it('exits 2 with usage when no PR or files JSON is supplied', () => {
    const result = runLoc([])

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('--from-pr')
  })

  it('is a no-checkout GitHub-hosted PR workflow', () => {
    expect(locJob['runs-on']).toBe('ubuntu-latest')
    expect(locJob.steps).toHaveLength(1)
    expect(locStep.run).toContain('gh api')
    expect(locStep.run).toContain('pr-test-loc-table.mjs')
    expect(locStep.run).toContain('pr-test-loc-summary.mjs')
    expect(locStep.run).toContain('--update-pr')
    expect(locWorkflow.permissions['pull-requests']).toBe('write')
    expect(JSON.stringify(locWorkflow)).not.toContain('actions/checkout')
    expect(JSON.stringify(locWorkflow)).not.toContain('self-hosted')
  })

  // The write-scoped GITHUB_TOKEN makes any PR-authored code a privilege escalation.
  it('executes only default-branch script code, never pull-request head code', () => {
    const serialized = JSON.stringify(locWorkflow)

    expect(locStep.env.TRUSTED_REF).toBe('${{ github.event.repository.default_branch }}')
    expect(locStep.run).toContain('?ref=${TRUSTED_REF}')
    expect(serialized).not.toContain('pull_request_target')
    expect(serialized).not.toContain('pull/')
    expect(serialized).not.toContain('pull_request.head')
    expect(serialized).not.toContain('/merge')
  })

  it('passes event data through env instead of interpolating it into the shell', () => {
    expect(locStep.env.PR_NUMBER).toBe('${{ github.event.pull_request.number }}')
    expect(locStep.run).toContain('--update-pr "$PR_NUMBER"')
    expect(locStep.run).not.toContain('${{')
  })

  it('fails the step when a script download fails instead of running a truncated file', () => {
    expect(locStep.run).toContain('set -euo pipefail')
  })
})
