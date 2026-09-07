#!/usr/bin/env node

// Converts worktrees that already have their own Electron dist over to the shared cache.
// A normal install only shares when Electron is (re)installed, and an existing healthy worktree
// never reaches that path -- so without this, sharing only arrives at the next Electron upgrade.

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import {
  hasAdoptedSharedElectronDist,
  isUsableElectronDist,
  publishSharedElectronDist,
  recordAdoptedSharedElectronDist,
  resolveSharedElectronDistEntry,
  shareElectronDistFromCache
} from './shared-electron-dist-cache.mjs'
import { getElectronPlatformPath } from './electron-platform-path.mjs'

const apply = process.argv.includes('--apply')
const repoRoot = process.argv.includes('--repo')
  ? path.resolve(process.argv[process.argv.indexOf('--repo') + 1])
  : process.cwd()

function listWorktrees(root) {
  const raw = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8'
  })
  return raw
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
}

/** Apparent size, walked in Node: `du` does not exist on Windows, where it silently reported 0. */
function measure(targetPath) {
  let total = 0
  let entries
  try {
    entries = readdirSync(targetPath, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const entryPath = path.join(targetPath, entry.name)
    if (entry.isDirectory()) {
      total += measure(entryPath)
    } else if (!entry.isSymbolicLink()) {
      total += statSync(entryPath, { throwIfNoEntry: false })?.size ?? 0
    }
  }
  return total
}

/** Swap in a shared copy behind a rename, so an interrupted run never leaves a partial dist. */
function adoptInto(distPath, entry, identity) {
  const stagePath = `${distPath}.reclaim-${process.pid}-${randomUUID()}`
  if (!shareElectronDistFromCache(entry, stagePath, identity)) {
    rmSync(stagePath, { recursive: true, force: true })
    return false
  }
  const previousPath = `${distPath}.previous-${process.pid}-${randomUUID()}`
  renameSync(distPath, previousPath)
  try {
    renameSync(stagePath, distPath)
  } catch (error) {
    renameSync(previousPath, distPath)
    rmSync(stagePath, { recursive: true, force: true })
    throw error
  }
  rmSync(previousPath, { recursive: true, force: true })
  return true
}

function main() {
  let reclaimed = 0
  let converted = 0
  let skipped = 0

  for (const worktree of listWorktrees(repoRoot)) {
    const electronPackageDir = path.join(worktree, 'node_modules', 'electron')
    const distPath = path.join(electronPackageDir, 'dist')
    if (!existsSync(path.join(electronPackageDir, 'package.json')) || !existsSync(distPath)) {
      continue
    }
    if (statSync(distPath, { throwIfNoEntry: false })?.isDirectory() !== true) {
      continue
    }

    let version
    try {
      version = JSON.parse(
        readFileSync(path.join(electronPackageDir, 'package.json'), 'utf8')
      ).version
    } catch {
      continue
    }
    const targetPlatform = process.platform
    const targetArch = process.arch
    let platformPath
    try {
      platformPath = getElectronPlatformPath(targetPlatform)
    } catch {
      continue
    }
    if (!isUsableElectronDist(distPath, version, platformPath)) {
      console.log(`skip  ${worktree}  (dist is not a complete Electron ${version})`)
      skipped += 1
      continue
    }

    const entry = resolveSharedElectronDistEntry({
      repoRoot: worktree,
      electronPackageDir,
      version,
      targetPlatform,
      targetArch
    })
    if (entry === null) {
      continue
    }
    if (hasAdoptedSharedElectronDist(entry)) {
      continue
    }

    const size = measure(distPath)
    if (!apply) {
      console.log(`would share  ${worktree}  ${(size / 1024 ** 3).toFixed(2)} GiB  (${version})`)
      reclaimed += size
      converted += 1
      continue
    }

    try {
      if (!existsSync(entry.entryPath)) {
        if (publishSharedElectronDist(distPath, entry, { version, platformPath })) {
          recordAdoptedSharedElectronDist(entry, writeFileSync)
          console.log(`seeded  ${worktree}  -> ${entry.entryPath}`)
          converted += 1
        }
        continue
      }
      if (adoptInto(distPath, entry, { version, platformPath })) {
        recordAdoptedSharedElectronDist(entry, writeFileSync)
        reclaimed += size
        converted += 1
        console.log(`shared  ${worktree}  reclaimed ${(size / 1024 ** 3).toFixed(2)} GiB`)
      }
    } catch (error) {
      // A worktree that fails is left exactly as it was; it still has its own working dist.
      console.warn(`skip  ${worktree}  (${error instanceof Error ? error.message : String(error)})`)
      skipped += 1
    }
  }

  console.log(
    `\n${apply ? 'Shared' : 'Would share'} ${converted} worktree(s); ` +
      `${apply ? 'reclaimed' : 'reclaimable'} ~${(reclaimed / 1024 ** 3).toFixed(2)} GiB` +
      `${skipped > 0 ? `; skipped ${skipped}` : ''}` +
      `${apply ? '' : '\nRe-run with --apply to do it.'}`
  )
}

// Guarded so importing this module for tests does not sweep the whole repository.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main()
}
