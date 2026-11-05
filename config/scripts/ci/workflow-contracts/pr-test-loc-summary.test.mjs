import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  listPullFiles,
  updatePullRequest
} from '../../../../.github/scripts/pr-test-loc-summary.mjs'
import {
  LOC_HANDS_OFF_COMMENT,
  mergeLocBlock,
  renderLocBlock,
  sumChangedFiles
} from '../../../../.github/scripts/pr-test-loc-table.mjs'

const projectDir = resolve(import.meta.dirname, '../../../..')
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
    const body = '## Description\n'
    const totals = {
      test: { files: 1, added: 2, deleted: 0 },
      nonTest: { files: 0, added: 0, deleted: 0 }
    }
    const delays = []
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
      totals,
      fetchImpl: async (url, options) => {
        requests.push({ url, options })
        if (requests.length === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ body })
          }
        }
        return responses.shift()
      },
      sleepImpl: async (milliseconds) => {
        delays.push(milliseconds)
      }
    })

    expect(result).toBe(0)
    expect(requests).toHaveLength(3)
    expect(requests.map(({ url }) => url)).toEqual(
      Array(3).fill('https://api.github.com/repos/stablyai/orca/pulls/14656')
    )
    for (const { options } of requests.slice(1)) {
      expect(options.method).toBe('PATCH')
      expect(JSON.parse(options.body)).toEqual({
        body: `${body}\n${renderLocBlock(totals)}\n`
      })
    }
    expect(delays).toEqual([1000])
  })

  it('renders the table with a hands-off marker', () => {
    const block = renderLocBlock({
      test: { files: 1, added: 2, deleted: 1 },
      nonTest: { files: 1, added: 4, deleted: 0 }
    })

    expect(block).toContain(LOC_HANDS_OFF_COMMENT)
    expect(block).toContain(
      '| Test | 1 | $\\color{#1a7f37}{\\Huge{\\mathbf{+}}}$​2 | $\\color{#cf222e}{\\Huge{\\mathbf{−}}}$​1 | $\\color{#1a7f37}{\\Huge{\\mathbf{+}}}$​1 |'
    )
    expect(block).toContain(
      '| Prod | 1 | $\\color{#1a7f37}{\\Huge{\\mathbf{+}}}$​4 | 0 | $\\color{#1a7f37}{\\Huge{\\mathbf{+}}}$​4 |'
    )
    expect(block).not.toContain('| Total |')
  })

  it('places the table after the ELI5 section so link unfurls stay readable', () => {
    const totals = {
      test: { files: 1, added: 2, deleted: 1 },
      nonTest: { files: 1, added: 4, deleted: 0 }
    }
    const block = renderLocBlock(totals)
    const expected = `## ELI5\n\nHello\n\n${block}\n\n## Why\n\nBecause\n`

    expect(mergeLocBlock('## ELI5\n\nHello\n\n## Why\n\nBecause\n', totals)).toBe(expected)
    // Idempotent once placed.
    expect(mergeLocBlock(expected, totals)).toBe(expected)
    // Migrates a block previously prepended at the top, including legacy formats.
    expect(mergeLocBlock(`${block}\n\n## ELI5\n\nHello\n\n## Why\n\nBecause\n`, totals)).toBe(
      expected
    )
    expect(
      mergeLocBlock(
        '<!-- orca-pr-loc -->\n**LoC** · test **+1 / −0**\n<!-- /orca-pr-loc -->\n\n## ELI5\n\nHello\n\n## Why\n\nBecause\n',
        totals
      )
    ).toBe(expected)
    // ELI5 subsections stay inside the section.
    expect(mergeLocBlock('## ELI5\n\nHi\n\n### Detail\n\nMore\n\n## Why\n', totals)).toBe(
      `## ELI5\n\nHi\n\n### Detail\n\nMore\n\n${block}\n\n## Why\n`
    )
  })

  it('appends the table when there is no ELI5 section to follow', () => {
    const totals = {
      test: { files: 0, added: 0, deleted: 0 },
      nonTest: { files: 1, added: 4, deleted: 0 }
    }
    const block = renderLocBlock(totals)

    expect(mergeLocBlock('## ELI5\n\nHello\n', totals)).toBe(`## ELI5\n\nHello\n\n${block}\n`)
    expect(mergeLocBlock('Bump deps\n', totals)).toBe(`Bump deps\n\n${block}\n`)
    expect(mergeLocBlock(`${block}\n\nBump deps\n`, totals)).toBe(`Bump deps\n\n${block}\n`)
    expect(mergeLocBlock('', totals)).toBe(`${block}\n`)
    expect(mergeLocBlock(null, totals)).toBe(`${block}\n`)
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
    expect(result.stdout.startsWith('## ELI5\n\nHello\n\n<!-- orca-pr-loc -->')).toBe(true)
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
})
