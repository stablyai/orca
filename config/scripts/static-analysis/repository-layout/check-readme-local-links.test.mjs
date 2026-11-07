import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findBrokenReadmeLinks } from './check-readme-local-links.mjs'

const roots = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function repoWith(readme, trackedFiles) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-readme-links-'))
  roots.push(root)
  execFileSync('git', ['init', '-q'], { cwd: root })
  for (const file of ['docs/readme/README.ja.md', ...trackedFiles]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), '')
  }
  writeFileSync(path.join(root, 'README.md'), readme)
  execFileSync('git', ['add', '-A'], { cwd: root })
  return root
}

describe('findBrokenReadmeLinks with angle-bracket destinations', () => {
  it('reports a missing file whose path has a space', () => {
    const root = repoWith('![missing](<docs/missing image.png>)\n', [])
    expect(findBrokenReadmeLinks(root).map((link) => link.resolved)).toEqual([
      'docs/missing image.png'
    ])
  })

  it('checks the whole path when it contains parentheses', () => {
    const root = repoWith('[present](<docs/a (1).png>)\n[absent](<docs/b (2).png>)\n', [
      'docs/a (1).png'
    ])
    expect(findBrokenReadmeLinks(root).map((link) => link.resolved)).toEqual(['docs/b (2).png'])
  })
})
