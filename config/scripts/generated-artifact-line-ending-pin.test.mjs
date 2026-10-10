import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../..')

it('keeps byte-compared artifacts and source LF in an autocrlf checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-line-ending-checkout-'))
  const lf = 'first\nsecond\n'
  const crlf = 'first\r\nsecond\r\n'
  const paths = new Map([
    ['resources/skills/current-manifest.json', lf],
    ['resources/skills/snapshot-registry.json', lf],
    ['resources/skills/release-mapping.json', lf],
    ['src/main/__snapshots__/example.test.ts.snap', lf],
    ['src/renderer/src/example.tsx', lf],
    ['src/main/example.ts', lf],
    ['config/scripts/example.mjs', lf],
    ...['cmd', 'bat', 'ps1', 'nsh'].map((extension) => [`config/example.${extension}`, crlf]),
    ['resources/skills-extra/example.json', crlf],
    ['vendor/resources/skills/example.json', crlf],
    ['scripts/example.mjs', crlf],
    ['src/main/runtime/__fixtures__/example.txt', crlf],
    ['src/main/daemon/__fixtures__/pty-transcripts/example.txt', crlf]
  ])
  const git = (args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })

  try {
    git(['init', '--quiet'])
    writeFileSync(join(root, '.gitattributes'), readFileSync(join(projectDir, '.gitattributes')))
    for (const path of paths.keys()) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), path.includes('__fixtures__') ? crlf : lf)
    }
    git(['-c', 'core.autocrlf=input', 'add', '--', '.'])
    for (const path of paths.keys()) {
      rmSync(join(root, path))
    }
    git(['-c', 'core.autocrlf=true', 'checkout-index', '--all', '--force'])

    for (const [path, expected] of paths) {
      expect(readFileSync(join(root, path), 'utf8'), path).toBe(expected)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
