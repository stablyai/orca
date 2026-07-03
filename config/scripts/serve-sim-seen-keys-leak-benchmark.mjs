#!/usr/bin/env node
// Benchmark: main-process retained-Set growth of the serve-sim state watcher's
// external-helper dedupe across worktree switches.
//
// emitIfExternal() records one entry per (worktreeId, deviceUdid, pid, wsUrl,
// streamUrl) tuple in `seenExternalKeys` so a helper is only auto-tabbed once.
// Before the fix, forgetWorktree() pruned ptyToWorktree and ptyBuffers but never
// touched seenExternalKeys, so its keys accumulated for the renderer/main
// process lifetime — only cleared at app shutdown (stop()). This script
// simulates N bind→detect→forget cycles and reports retained Set size with the
// prune disabled vs enabled.
import { performance } from 'node:perf_hooks'

const CYCLES = Number.parseInt(process.env.ORCA_SEEN_KEYS_BENCH_CYCLES ?? '5000', 10)
const HELPERS_PER_WORKTREE = Number.parseInt(process.env.ORCA_SEEN_KEYS_BENCH_HELPERS ?? '2', 10)

for (const [name, value] of [
  ['ORCA_SEEN_KEYS_BENCH_CYCLES', CYCLES],
  ['ORCA_SEEN_KEYS_BENCH_HELPERS', HELPERS_PER_WORKTREE]
]) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${value}`)
  }
}

// Mirror of the watcher's dedupe bookkeeping (serve-sim-state-watcher.ts): a
// Set of `${worktreeId}::${instanceKey}` keys, plus the prefix-prune the fix
// adds to forgetWorktree().
function makeWatcher({ prune }) {
  const seenExternalKeys = new Set()
  return {
    set: seenExternalKeys,
    emitIfExternal(worktreeId, instanceKey) {
      const dedupeKey = `${worktreeId}::${instanceKey}`
      if (seenExternalKeys.has(dedupeKey)) {
        return false
      }
      seenExternalKeys.add(dedupeKey)
      return true
    },
    forgetWorktree(worktreeId) {
      if (!prune) {
        return
      }
      const prefix = `${worktreeId}::`
      for (const key of seenExternalKeys) {
        if (key.startsWith(prefix)) {
          seenExternalKeys.delete(key)
        }
      }
    }
  }
}

function run({ prune }) {
  const watcher = makeWatcher({ prune })
  const start = performance.now()
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    const worktreeId = `worktree-${cycle}`
    for (let h = 0; h < HELPERS_PER_WORKTREE; h++) {
      // A realistic instance key: device udid :: pid :: wsUrl :: streamUrl.
      const instanceKey = `udid-${cycle}-${h}::pid-${1000 + h}::ws://127.0.0.1:${3100 + h}/ws::http://127.0.0.1:${3100 + h}/stream.mjpeg`
      watcher.emitIfExternal(worktreeId, instanceKey)
    }
    watcher.forgetWorktree(worktreeId)
  }
  return { retained: watcher.set.size, elapsedMs: performance.now() - start }
}

console.log(
  `serve-sim seenExternalKeys leak benchmark: ${CYCLES} worktree open/forget cycles, ` +
    `${HELPERS_PER_WORKTREE} helper(s)/worktree\n`
)

const before = run({ prune: false })
const after = run({ prune: true })

// Each key is ~120-160 bytes (worktreeId + udid + pid + two URLs).
const APPROX_BYTES_PER_KEY = 140
const leakedKb = (before.retained * APPROX_BYTES_PER_KEY) / 1024

console.log(
  `before (no prune)  retained=${before.retained} keys  ` +
    `(~${leakedKb.toFixed(0)} KiB)  time=${before.elapsedMs.toFixed(1)}ms`
)
console.log(
  `after  (prune)     retained=${after.retained} keys  ` +
    `(~0 KiB)  time=${after.elapsedMs.toFixed(1)}ms`
)
console.log(
  `\nBounded the dedupe Set to live worktrees: ${before.retained} → ${after.retained} ` +
    `retained keys after ${CYCLES} worktree switches.`
)
