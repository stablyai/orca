import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { findBrokenReadmeLinks, main } from './check-readme-local-links.mjs'

const projectDir = path.resolve(import.meta.dirname, '../..')
const tempDirs = []

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function writeFiles(root, files) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(root, relativePath)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
}

function makeFixture(files, { untracked = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-readme-links-'))
  tempDirs.push(root)
  git(root, ['init', '--quiet'])
  git(root, ['config', 'user.email', 'readme-links-test@example.com'])
  git(root, ['config', 'user.name', 'README Links Test'])
  writeFiles(root, files)
  git(root, ['add', '-A'])
  git(root, ['commit', '--quiet', '-m', 'fixture'])
  writeFiles(root, untracked)
  return root
}

const validReadmes = {
  'README.md': [
    '<img src="resources/build/icon.png" />',
    '<picture><source srcset="docs/site/public/docs/tab-split.gif" type="image/gif"><img src="resources/onboarding/feature-wall/tile-01.poster.jpg" /></picture>',
    '<a href="docs/readme/README.ja.md">日本語</a>',
    "<img src='resources/build/icon.png' />",
    '<img src="https://img.shields.io/badge/x-y-z" />',
    '[Contributing](.github/CONTRIBUTING.md) [Docs](https://example.com/docs) [Top](#top)',
    '![hero](docs/assets/hero%20image.jpg "Hero")'
  ].join('\n'),
  'docs/readme/README.ja.md': [
    '<img src="../../resources/build/icon.png" />',
    '<source srcset="../site/public/docs/tab-split.gif">',
    '<a href="../../README.md">English</a> <a href="README.ja.md#top">self</a>',
    '[LICENSE](../../LICENSE)'
  ].join('\n'),
  'resources/build/icon.png': 'png',
  'resources/onboarding/feature-wall/tile-01.poster.jpg': 'jpg',
  'docs/site/public/docs/tab-split.gif': 'gif',
  'docs/assets/hero image.jpg': 'jpg',
  '.github/CONTRIBUTING.md': 'contributing',
  LICENSE: 'mit'
}

afterEach(() => {
  vi.restoreAllMocks()
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true })
  }
})

describe('README local link check', () => {
  it('accepts the checked-in READMEs', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(main(projectDir)).toBe(0)
  })

  it('accepts local links in every supported shape', () => {
    expect(findBrokenReadmeLinks(makeFixture(validReadmes))).toEqual([])
  })

  it('reports a deleted media file for the root and translated READMEs', () => {
    const { 'docs/site/public/docs/tab-split.gif': _gif, ...files } = validReadmes
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeFixture(files)

    expect(findBrokenReadmeLinks(root)).toEqual([
      {
        readme: 'README.md',
        target: 'docs/site/public/docs/tab-split.gif',
        resolved: 'docs/site/public/docs/tab-split.gif'
      },
      {
        readme: 'docs/readme/README.ja.md',
        target: '../site/public/docs/tab-split.gif',
        resolved: 'docs/site/public/docs/tab-split.gif'
      }
    ])
    expect(main(root)).toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('README.md: docs/site/public/docs/tab-split.gif')
    )
  })

  // Why: GitHub renders the commit, so a file that only exists on disk is broken.
  it('reports a referenced file that exists on disk but is not tracked', () => {
    const { 'resources/build/icon.png': icon, ...files } = validReadmes
    const root = makeFixture(files, { untracked: { 'resources/build/icon.png': icon } })

    expect(findBrokenReadmeLinks(root).map((link) => link.resolved)).toEqual([
      'resources/build/icon.png',
      'resources/build/icon.png'
    ])
  })

  it('reports a link that escapes the repository', () => {
    const root = makeFixture({
      ...validReadmes,
      'docs/readme/README.ja.md': '<img src="../../../outside.png" />'
    })

    expect(findBrokenReadmeLinks(root)).toEqual([
      { readme: 'docs/readme/README.ja.md', target: '../../../outside.png', resolved: null }
    ])
  })

  // Why: a single-quoted attribute is valid HTML and GitHub renders it, so a parser
  // that only reads double quotes would pass a README with a broken image.
  it('reports a missing target in a single-quoted attribute', () => {
    const files = {
      ...validReadmes,
      'README.md': `${validReadmes['README.md']}\n<img src='docs/assets/missing.gif' />`
    }

    expect(findBrokenReadmeLinks(makeFixture(files))).toEqual([
      {
        readme: 'README.md',
        target: 'docs/assets/missing.gif',
        resolved: 'docs/assets/missing.gif'
      }
    ])
  })

  // Why the ungated job: static_analysis is skipped for docs-only diffs, which is
  // exactly the kind of PR that deletes a docs-site GIF the README embeds.
  it('runs on every PR through the ungated guard job and in the lint script', () => {
    const { scripts } = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8'))
    const workflow = parse(readFileSync(path.join(projectDir, '.github/workflows/pr.yml'), 'utf8'))
    const guardJob = workflow.jobs.root_directory_guard
    const step = guardJob.steps.find((candidate) => candidate.name === 'Check README local links')

    expect(guardJob.if).toBeUndefined()
    expect(guardJob.needs).toBeUndefined()
    expect(step.run).toBe('node config/scripts/check-readme-local-links.mjs')
    expect(scripts['check:readme-local-links']).toBe(
      'node config/scripts/check-readme-local-links.mjs'
    )
    expect(scripts.lint).toContain('pnpm run check:readme-local-links')
  })
})
