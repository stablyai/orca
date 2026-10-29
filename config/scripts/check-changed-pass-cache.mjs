import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const PASS_CACHE_PATH = '.cache/check-changed.json'
const CACHE_VERSION = 1

// Inputs outside the diff that still decide what the checks report.
const HASHED_CONFIG_FILES = [
  'pnpm-lock.yaml',
  'package.json',
  '.oxlintrc.json',
  '.oxfmtrc.json',
  'config/vitest.config.ts',
  'config/scripts/check-changed.mjs',
  'config/scripts/check-changed-selection.mjs',
  'config/scripts/check-changed-pass-cache.mjs'
]

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function splitNullDelimited(output) {
  return output.split('\0').filter(Boolean)
}

function readIfFile(file) {
  try {
    return statSync(file).isFile() ? readFileSync(file) : null
  } catch {
    return null
  }
}

/** Committed, staged, unstaged, and untracked paths relative to the merge base, deletions included. */
export function collectChangedFiles(root, mergeBase) {
  const tracked = splitNullDelimited(
    git(root, ['diff', '--name-only', '--no-renames', '-z', mergeBase, '--'])
  )
  const untracked = splitNullDelimited(
    git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  )
  return [...new Set([...tracked, ...untracked])].sort()
}

export function computePassHash(root, mergeBase) {
  const hash = createHash('sha256')
  const field = (label, value) => {
    hash.update(`${label}\0${value.length}\0`)
    hash.update(value)
  }
  field('version', String(CACHE_VERSION))
  field('runtime', `${process.platform} ${process.arch} ${process.version}`)
  field('base', mergeBase)
  // Base plus each changed path's working-tree bytes pins the tree like the diff does, but stays
  // stable when an edit is staged or committed, so committing a passing change keeps its pass.
  for (const file of collectChangedFiles(root, mergeBase)) {
    field('changed', file)
    field('content', readIfFile(path.join(root, file)) ?? '\0deleted')
  }
  for (const file of HASHED_CONFIG_FILES) {
    field('config', file)
    field('content', readIfFile(path.join(root, file)) ?? '')
  }
  return hash.digest('hex')
}

export function readPassHash(root) {
  try {
    const { version, hash } = JSON.parse(readFileSync(path.join(root, PASS_CACHE_PATH), 'utf8'))
    return version === CACHE_VERSION && typeof hash === 'string' ? hash : null
  } catch {
    return null
  }
}

export function writePassHash(root, hash) {
  const file = path.join(root, PASS_CACHE_PATH)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(
    file,
    `${JSON.stringify({ version: CACHE_VERSION, hash, passedAt: new Date().toISOString() })}\n`
  )
}
