#!/usr/bin/env node
import { lstat, readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { lock } from 'proper-lockfile'
import { localRepositoryWorktrees } from './local-repository-worktrees.mjs'
import { getDevBundleProcessTable } from './dev-electron-bundle-cache.mjs'
import { worktreeActiveSince } from './worktree-recent-activity.mjs'
import { CHECKOUT_FORMAT } from '../../tests/e2e/cross-version-wire/release-checkout-publication.ts'
import { withReleaseSourceFormatLease } from '../../tests/e2e/cross-version-wire/release-source-retention.ts'

const COMMIT = '(?:[\\da-f]{40}|[\\da-f]{64})'
const LOCAL_ENTRY = new RegExp(`^(${COMMIT})-format-([1-9]\\d*)$`)
const SHARED_ENTRY = new RegExp(`^(${COMMIT})$`)
const DAY_MS = 24 * 60 * 60 * 1000

async function directory(path) {
  try {
    const info = await lstat(path)
    return info.isDirectory() && !info.isSymbolicLink() ? info : null
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function descend(root, parts) {
  let path = root
  for (const part of parts) {
    path = join(path, part)
    if (!(await directory(path))) {
      return null
    }
  }
  return path
}

async function matchingStamp(path, commit, format) {
  try {
    const marker = join(path, 'checkout-stamp.json')
    const info = await lstat(marker)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) {
      return false
    }
    const value = JSON.parse(await readFile(marker, 'utf8'))
    return value?.commit === commit && value?.format === format
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) {
      return false
    }
    throw error
  }
}

async function logicalBytes(root) {
  let bytes = 0
  const pending = [root]
  while (pending.length) {
    const path = pending.pop()
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      const info = await lstat(child)
      if (info.isDirectory() && !info.isSymbolicLink()) {
        pending.push(child)
      } else if (info.isFile() && !info.isSymbolicLink()) {
        bytes += info.size
      }
    }
  }
  return bytes
}

export async function reclaimReleaseTestCaches({
  repoRoot = process.cwd(),
  apply = false,
  testsStopped = false,
  minAgeDays = 30,
  idleDays = 7,
  nowMs = Date.now(),
  targets,
  getProcessTable = getDevBundleProcessTable,
  report = console.log
} = {}) {
  if (!Number.isFinite(minAgeDays) || minAgeDays < 0) {
    throw new Error('--min-age-days requires a non-negative number')
  }
  if (!Number.isFinite(idleDays) || idleDays < 0) {
    throw new Error('--idle-days requires a non-negative number')
  }
  const { commonDirectory, worktrees } = targets ?? (await localRepositoryWorktrees(repoRoot))
  const cutoff = nowMs - minAgeDays * DAY_MS
  const idleCutoff = nowMs - idleDays * DAY_MS
  const processTable = testsStopped ? '' : getProcessTable()
  const result = { entries: 0, logicalBytes: 0, protected: 0 }

  async function processEntry(path, commit, format, recheckParents, verifyLease = () => {}) {
    const info = await directory(path)
    if (!info || info.mtimeMs > cutoff || !(await matchingStamp(path, commit, format))) {
      return
    }
    let release
    try {
      if (apply) {
        release = await lock(path, { realpath: false, stale: 60_000, retries: 0 })
      }
    } catch (error) {
      if (error.code !== 'ELOCKED') {
        throw error
      }
      result.protected += 1
      report(`skip locked cache ${JSON.stringify(path)}`)
      return
    }
    try {
      const bytes = await logicalBytes(path)
      if (apply) {
        verifyLease()
        if (!(await recheckParents())) {
          return
        }
        const current = await directory(path)
        if (
          !current ||
          current.dev !== info.dev ||
          current.ino !== info.ino ||
          current.mtimeMs > cutoff ||
          !(await matchingStamp(path, commit, format))
        ) {
          return
        }
        verifyLease()
        await rm(path, { recursive: true, force: true })
      }
      result.entries += 1
      result.logicalBytes += bytes
      report(
        `${apply ? 'removed' : 'would remove'} ${JSON.stringify(path)} ${(bytes / 1024 ** 2).toFixed(1)} MiB logical`
      )
    } finally {
      await release?.()
    }
  }

  for (const worktree of new Set(worktrees)) {
    const cache = await descend(worktree, ['tests', 'e2e', '.cross-version-checkouts'])
    if (!cache) {
      continue
    }
    // Older harnesses hold no lease while tests read a checkout, so only idle worktrees are safe.
    let active
    const isActive = async () => {
      if (active === undefined) {
        active = !testsStopped && (await worktreeActiveSince(worktree, idleCutoff, processTable))
        result.protected += active ? 1 : 0
      }
      return active
    }
    for (const label of await readdir(cache, { withFileTypes: true })) {
      if (!label.isDirectory() || label.isSymbolicLink()) {
        continue
      }
      const labelRoot = join(cache, label.name)
      for (const entry of await readdir(labelRoot, { withFileTypes: true })) {
        const match = LOCAL_ENTRY.exec(entry.name)
        if (!entry.isDirectory() || !match || Number(match[2]) > CHECKOUT_FORMAT) {
          continue
        }
        if (await isActive()) {
          break
        }
        await processEntry(join(labelRoot, entry.name), match[1], Number(match[2]), async () =>
          Boolean(await descend(worktree, ['tests', 'e2e', '.cross-version-checkouts', label.name]))
        )
      }
    }
  }

  const shared = await descend(commonDirectory, ['orca-cache', 'release-source'])
  if (shared) {
    for (const entry of await readdir(shared, { withFileTypes: true })) {
      const match = /^format-([1-9]\d*)$/.exec(entry.name)
      if (!entry.isDirectory() || !match || Number(match[1]) > CHECKOUT_FORMAT) {
        continue
      }
      if (!(await directory(join(shared, entry.name)))) {
        continue
      }
      const format = Number(match[1])
      const visit = async (formatRoot, verifyLease) => {
        for (const seed of await readdir(formatRoot, { withFileTypes: true })) {
          const key = SHARED_ENTRY.exec(seed.name)
          if (!seed.isDirectory() || !key) {
            continue
          }
          await processEntry(
            join(formatRoot, seed.name),
            key[1],
            format,
            async () =>
              Boolean(await descend(commonDirectory, ['orca-cache', 'release-source', entry.name])),
            verifyLease
          )
        }
      }
      if (!apply) {
        await visit(join(shared, entry.name), () => {})
      } else {
        try {
          await withReleaseSourceFormatLease(shared, format, visit, {
            realpath: false,
            stale: 60_000,
            update: 10_000,
            retries: {
              retries: 0,
              factor: 1,
              minTimeout: 250,
              maxTimeout: 250,
              randomize: false
            }
          })
        } catch (error) {
          if (error.code !== 'ELOCKED') {
            throw error
          }
          result.protected += 1
          report(`skip locked shared format ${entry.name}`)
        }
      }
    }
  }
  report(
    `${apply ? 'Removed' : 'Would remove'} ${result.entries} cache(s); ${(result.logicalBytes / 1024 ** 3).toFixed(2)} GiB logical file data; retained caches in ${result.protected} active worktree(s) or locked location(s). Shared blocks affect actual savings.`
  )
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const options = {}
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index]
    if (argument === '--help') {
      console.log(
        'Usage: node config/scripts/reclaim-release-test-caches.mjs [--repo DIRECTORY] [--min-age-days 30] [--idle-days 7] [--tests-stopped] [--apply]'
      )
      process.exit(0)
    }
    if (argument === '--apply') {
      options.apply = true
    } else if (argument === '--tests-stopped') {
      options.testsStopped = true
    } else if (
      argument === '--repo' ||
      argument === '--min-age-days' ||
      argument === '--idle-days'
    ) {
      const value = process.argv[++index]
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} requires a value`)
      }
      if (argument === '--repo') {
        options.repoRoot = resolve(value)
      } else if (argument === '--idle-days') {
        options.idleDays = Number(value)
      } else {
        options.minAgeDays = Number(value)
      }
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  await reclaimReleaseTestCaches(options).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
