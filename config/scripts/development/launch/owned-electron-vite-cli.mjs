import { execFileSync, spawn } from 'node:child_process'
import { Socket } from 'node:net'
import { pathToFileURL } from 'node:url'
import { isDirectInvocation } from '../../tool-invocation/script-entry-detection.mjs'
import { withDevRolldownRuntimeEnv } from './dev-rolldown-runtime-env.mjs'

const launcherPid = process.ppid

// An unattended launch can outlive its task while pnpm and intermediate shells stay alive.
function backgroundLauncherAncestors() {
  if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
    return []
  }
  try {
    const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const parents = new Map(
      rows
        .trim()
        .split('\n')
        .map((row) => row.trim().split(/\s+/).map(Number))
    )
    const ancestors = new Set()
    let pid = parents.get(launcherPid)
    while (pid > 1 && !ancestors.has(pid)) {
      ancestors.add(pid)
      pid = parents.get(pid)
    }
    return [...ancestors]
  } catch {
    return []
  }
}

function processExited(pid) {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

export function spawnOwnedElectronVite(args, beginShutdown) {
  const ownsProcessGroup = process.platform !== 'win32'
  if (ownsProcessGroup) {
    const ancestors = backgroundLauncherAncestors()
    process.on('SIGHUP', () => beginShutdown('SIGTERM'))
    setInterval(() => {
      if (process.ppid !== launcherPid || ancestors.some(processExited)) {
        beginShutdown('SIGTERM')
      }
    }, 1000).unref()
  }

  return spawn(process.execPath, ownsProcessGroup ? [import.meta.filename, ...args] : args, {
    env: withDevRolldownRuntimeEnv(process.env),
    stdio: ownsProcessGroup ? ['inherit', 'inherit', 'inherit', 'pipe'] : 'inherit',
    detached: ownsProcessGroup
  })
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  // FD 3 closes even if the wrapper is killed. This PID owns the detached POSIX group.
  const owner = new Socket({ fd: 3, readable: true, writable: false })
  function stopOrphanedGroup() {
    process.kill(-process.pid, 'SIGKILL')
  }
  owner.once('end', stopOrphanedGroup)
  owner.once('error', stopOrphanedGroup)
  owner.resume()
  owner.unref()

  process.argv.splice(1, 1)
  await import(pathToFileURL(process.argv[1]).href)
}
