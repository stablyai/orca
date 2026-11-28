import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const MAX_ANCESTORS = 16

/** True only when the OS says no such process; any other answer counts as still running. */
export function processGone(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return true
  }
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error.code === 'ESRCH'
  }
}

function currentDirectory() {
  try {
    return process.cwd()
  } catch {
    return ''
  }
}

/**
 * This process's launchers: the processes above it when it queues, up to MAX_ANCESTORS levels,
 * stopping at init or at the first link that cannot be read. One ps call per acquisition on
 * macOS (none on Linux); nothing is inferred when it fails.
 */
export function describeSelf(ancestors) {
  const self = { pid: process.pid, cwd: currentDirectory(), ancestors }
  if (ancestors !== undefined) {
    return self
  }
  let parentOf
  if (process.platform === 'linux') {
    parentOf = (pid) => {
      try {
        const text = readFileSync(`/proc/${pid}/stat`, 'utf8')
        // The command name can hold spaces and parentheses; fields resume after the last ')'.
        return Number(text.slice(text.lastIndexOf(')') + 2).split(' ')[1]) || 0
      } catch {
        return 0
      }
    }
  } else {
    const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 })
    const parents = new Map()
    if (result.status === 0) {
      for (const line of result.stdout.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
        if (match) {
          parents.set(Number(match[1]), Number(match[2]))
        }
      }
    }
    parentOf = (pid) => parents.get(pid) ?? 0
  }
  self.ancestors = []
  for (
    let pid = process.ppid;
    pid > 1 && self.ancestors.length < MAX_ANCESTORS;
    pid = parentOf(pid)
  ) {
    if (self.ancestors.includes(pid)) {
      break
    }
    self.ancestors.push(pid)
  }
  return self
}
