import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  collectChangedFiles,
  computePassHash,
  readPassHash,
  writePassHash
} from './check-changed-pass-cache.mjs'

let root
let base

function git(...args) {
  const result = runProcessSync({ program: 'git', args, cwd: root })
  expect(result.code, result.stderr).toBe(0)
  return result.stdout.trim()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'check-changed-'))
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(join(root, '.gitignore'), '.cache/\n')
  writeFileSync(join(root, 'tracked.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  base = git('rev-parse', 'HEAD')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

it('keys the pass on every edit state and ignores its own cache file', () => {
  expect(collectChangedFiles(root, base)).toEqual([])

  writeFileSync(join(root, 'tracked.ts'), 'export const a = 2\n')
  const unstaged = computePassHash(root, base)
  writePassHash(root, unstaged)
  expect(readPassHash(root)).toBe(unstaged)
  expect(computePassHash(root, base)).toBe(unstaged)

  git('add', 'tracked.ts')
  expect(computePassHash(root, base)).toBe(unstaged)
  git('commit', '-qm', 'edit')
  expect(computePassHash(root, base)).toBe(unstaged)
  expect(collectChangedFiles(root, base)).toEqual(['tracked.ts'])

  writeFileSync(join(root, 'new.ts'), 'export const b = 1\n')
  const untracked = computePassHash(root, base)
  expect(untracked).not.toBe(unstaged)
  writeFileSync(join(root, 'new.ts'), 'export const b = 2\n')
  expect(computePassHash(root, base)).not.toBe(untracked)
  expect(collectChangedFiles(root, base)).toEqual(['new.ts', 'tracked.ts'])

  const beforeCommit = computePassHash(root, base)
  git('add', 'new.ts')
  git('commit', '-qm', 'add')
  expect(computePassHash(root, base)).toBe(beforeCommit)

  const beforeLockfile = computePassHash(root, base)
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 10\n')
  expect(computePassHash(root, base)).not.toBe(beforeLockfile)
})
