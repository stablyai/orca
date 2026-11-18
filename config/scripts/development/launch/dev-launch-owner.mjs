import { execFile, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

function captureDevLaunchOwner() {
  const explicitOwner = process.env.ORCA_DEV_OWNER_PID
  delete process.env.ORCA_DEV_OWNER_PID
  if (process.platform === 'win32' || process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
    return () => () => {}
  }

  const parentPid = explicitOwner === undefined ? process.ppid : Number(explicitOwner)
  if (!Number.isSafeInteger(parentPid) || parentPid <= 1 || parentPid > 2147483647) {
    throw new Error('Background dev launches need a live owner; use a persistent command session.')
  }

  const ancestors = new Set([parentPid])
  if (explicitOwner === undefined) {
    try {
      // Capture once: pnpm and its script shell can survive after their launching agent exits.
      const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore']
      })
      const parents = new Map(
        rows
          .trim()
          .split('\n')
          .map((row) => row.trim().split(/\s+/).map(Number))
      )
      let pid = parents.get(parentPid)
      while (pid > 1 && !ancestors.has(pid)) {
        ancestors.add(pid)
        pid = parents.get(pid)
      }
    } catch (error) {
      console.warn(`[orca-dev] Could not capture launch ancestors: ${error.message}`)
    }
  }

  return (onOwnerExit) => {
    let watching = true
    let probe = null
    let ticks = 0
    const stopWatching = () => {
      watching = false
      clearInterval(timer)
      probe?.kill()
    }
    const ownerExit = () => {
      if (!watching) {
        return
      }
      stopWatching()
      console.error('[orca-dev] Launch owner exited; stopping background dev instance')
      onOwnerExit()
    }
    const timer = setInterval(() => {
      const ownerExited =
        (explicitOwner === undefined && process.ppid !== parentPid) ||
        [...ancestors].some((pid) => {
          try {
            process.kill(pid, 0)
            if (process.platform === 'linux') {
              const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
              return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')
            }
            return false
          } catch (error) {
            return error.code === 'ESRCH' || error.code === 'ENOENT'
          }
        })
      if (ownerExited) {
        ownerExit()
      } else if (process.platform === 'darwin' && ++ticks % 30 === 0 && !probe) {
        // kill(0) sees unreaped owners as alive; keep macOS ps out of the one-second hot path.
        probe = execFile(
          '/bin/ps',
          ['-p', [...ancestors].join(','), '-o', 'stat='],
          {
            encoding: 'utf8',
            timeout: 2000
          },
          (_error, stdout) => {
            probe = null
            if (
              stdout
                .trim()
                .split(/\s+/)
                .some((state) => state.startsWith('Z'))
            ) {
              ownerExit()
            }
          }
        )
      }
    }, 1000)
    timer.unref()
    return stopWatching
  }
}

export const watchDevLaunchOwner = captureDevLaunchOwner()
