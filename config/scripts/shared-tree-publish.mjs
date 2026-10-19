import { randomUUID } from 'node:crypto'
import { existsSync, renameSync, rmSync, statSync } from 'node:fs'

/** A uniquely named sibling of `entryDir`, so concurrent publishers never share a staging tree. */
export function sharedTreeStagingPath(entryDir, uuid = randomUUID) {
  return `${entryDir}.staging-${process.pid}-${uuid()}`
}

/**
 * Move a fully built, validated `stagingDir` into place as `entryDir`, lock-free.
 *
 * Every worktree that shares the entry may be reading it, so a usable entry is never replaced,
 * and the entry is either absent, the old tree, or the new tree -- never half-written. A rename
 * onto a populated directory fails, so of two racing publishers one wins and the other just
 * removes its own staging tree. An unusable entry is quarantined first, and put back if the swap
 * fails, because a bad entry the next publisher can re-judge beats an empty one. The quarantined
 * tree must be the one judged unusable; a sibling's fresh publish that landed mid-judgement is
 * put back untouched.
 *
 * Re-checks the entry here, immediately before the rename, because staging takes long enough for
 * a sibling to publish a good one in the meantime. Returns true only when this call published.
 */
export function publishSharedTree(stagingDir, entryDir, options) {
  const { isUsable } = options
  const uuid = options.uuid ?? randomUUID
  const rename = options.rename ?? renameSync
  let quarantinePath = null
  if (existsSync(entryDir)) {
    const judged = treeIdentity(entryDir)
    if (isUsable(entryDir)) {
      rmSync(stagingDir, { recursive: true, force: true })
      return false
    }
    // Why: the probe takes long enough for a sibling to publish; don't even briefly move theirs.
    if (judged === null || treeIdentity(entryDir) !== judged) {
      rmSync(stagingDir, { recursive: true, force: true })
      return false
    }
    quarantinePath = `${entryDir}.unusable-${process.pid}-${uuid()}`
    try {
      renameSync(entryDir, quarantinePath)
    } catch {
      rmSync(stagingDir, { recursive: true, force: true })
      return false // Another publisher is already replacing it, or (Windows) it is loaded.
    }
    if (judged === null || treeIdentity(quarantinePath) !== judged) {
      rmSync(stagingDir, { recursive: true, force: true })
      try {
        renameSync(quarantinePath, entryDir)
      } catch {
        rmSync(quarantinePath, { recursive: true, force: true }) // A third publisher refilled it.
      }
      return false
    }
  }

  try {
    rename(stagingDir, entryDir)
  } catch {
    rmSync(stagingDir, { recursive: true, force: true })
    if (quarantinePath !== null) {
      try {
        renameSync(quarantinePath, entryDir)
        return false
      } catch {
        rmSync(quarantinePath, { recursive: true, force: true })
      }
    }
    return false
  }

  if (quarantinePath !== null) {
    rmSync(quarantinePath, { recursive: true, force: true })
  }
  return true
}

function treeIdentity(dir) {
  try {
    const { dev, ino } = statSync(dir, { bigint: true })
    return `${dev}:${ino}`
  } catch {
    return null
  }
}
