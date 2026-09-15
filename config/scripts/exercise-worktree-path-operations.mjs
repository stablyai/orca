import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const bundle = resolve(process.argv[2])
const root = mkdtempSync(join(tmpdir(), 'orca-path-operations-'))
const source = join(root, 'source')
const target = join(root, 'target')
try {
  mkdirSync(source)
  mkdirSync(target)
  execFileSync('git', ['init', '-q', source])
  writeFileSync(join(source, '.gitignore'), '.env\ndeps/\n')
  writeFileSync(join(source, '.worktreeinclude'), '.env\n')
  writeFileSync(join(source, '.env'), 'private')
  writeFileSync(join(source, 'orca.yaml'), 'worktree:\n  sharedDirectories:\n    - deps\n')
  mkdirSync(join(source, 'deps'))
  writeFileSync(join(source, 'deps', 'value'), 'shared')
  execFileSync('git', ['init', '-q', target])
  const request = (operation) =>
    JSON.parse(
      execFileSync(process.execPath, [bundle], {
        env: {
          ...process.env,
          ORCA_BACKGROUND_LAUNCH: '1',
          ORCA_WORKTREE_REQUEST: Buffer.from(
            JSON.stringify({ source, target, linkedPaths: [], ...(operation ? { operation } : {}) })
          ).toString('base64')
        },
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true
      })
    )
  assert.deepEqual(request(), { supported: true })
  assert.equal(readFileSync(join(target, '.env'), 'utf8'), 'private')
  assert.deepEqual(request('inspect-links'), { supported: true, paths: ['deps'] })
  assert.equal(lstatSync(join(target, 'deps')).isSymbolicLink(), true)
  assert.deepEqual(request('remove-links'), { supported: true, paths: ['deps'] })
  assert.throws(() => lstatSync(join(target, 'deps')), { code: 'ENOENT' })
  assert.equal(readFileSync(join(source, 'deps', 'value'), 'utf8'), 'shared')
  assert.equal(readFileSync(join(target, '.env'), 'utf8'), 'private')
  console.log(
    JSON.stringify({
      platform: process.platform,
      passed: true,
      operations: ['materialize', 'inspect-links', 'remove-links']
    })
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
