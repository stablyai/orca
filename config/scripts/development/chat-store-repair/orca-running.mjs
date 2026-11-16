// Whether an Orca app or orcad is using a profile folder, from the locks they hold there.
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readlinkSync } from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'

/** Why Orca may be using this profile, or null. Evidence that can't be checked counts as running. */
export function findRunningOrca(userData, probe = {}) {
  const host = probe.hostname ?? hostname()
  const alive = probe.isAlive ?? isAlive
  const name = probe.processName ?? processName
  const startedAt = probe.processStartedAtMs ?? processStartedAtMs
  const machine = probe.machineIdentity ?? machineIdentity
  const looksLikeOrca = (pid) => {
    const image = name(pid)
    // A reused PID after a crash belongs to something else; an unreadable name stays a refusal.
    return image === null || /orca|electron|node/i.test(image)
  }
  // Chromium's singleton: a "host-pid" symlink on macOS and Linux, removed when Orca quits.
  const singleton = path.join(userData, 'SingletonLock')
  if (lstatSync(singleton, { throwIfNoEntry: false })?.isSymbolicLink()) {
    const target = readlinkSync(singleton)
    const dash = target.lastIndexOf('-')
    const lockHost = target.slice(0, dash)
    const pid = Number(target.slice(dash + 1))
    if (lockHost !== host) {
      return `Orca on ${lockHost} may be using this profile. If no Orca runs there, open and quit Orca here once to clear it`
    }
    if (Number.isSafeInteger(pid) && pid > 0 && alive(pid) && looksLikeOrca(pid)) {
      return `Orca is running (process ${pid})`
    }
  }
  // On Windows, Chromium holds "lockfile" open without write sharing while it runs.
  const lockfile = path.join(userData, 'lockfile')
  if ((probe.platform ?? process.platform) === 'win32' && existsSync(lockfile)) {
    try {
      closeSync(openSync(lockfile, 'r+'))
    } catch (error) {
      if (['EBUSY', 'EPERM', 'EACCES'].includes(error?.code)) {
        return 'Orca is running (its lockfile is in use)'
      }
    }
  }
  // The desktop app and a standalone orcad both hold orcad.lock; it stays behind after they exit.
  const lockPath = path.join(userData, 'orcad.lock')
  let record
  try {
    record = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch {
    return null
  }
  if (!Number.isSafeInteger(record?.pid)) {
    return null
  }
  const ours = record.machineIdentity === undefined ? null : machine()
  const elsewhere =
    record.machineIdentity !== undefined
      ? ours !== record.machineIdentity
      : record.host !== undefined && record.host !== host
  if (elsewhere) {
    return `${lockPath} names ${record.host ?? 'another machine'}, process ${record.pid}. If no Orca or orcad runs there, delete that file`
  }
  if (!alive(record.pid) || !looksLikeOrca(record.pid)) {
    return null
  }
  const platform = probe.platform ?? process.platform
  if (record.linuxStartTicks !== undefined && record.bootId !== undefined) {
    // Linux records carry the kernel's own start identity; wall time there drifts.
    const actual = (probe.linuxIncarnation ?? linuxIncarnation)(record.pid)
    if (
      actual !== null &&
      (actual.bootId !== record.bootId || actual.startTicks !== record.linuxStartTicks)
    ) {
      return null
    }
  } else if (platform !== 'linux' && typeof record.startedAtMs === 'number') {
    const actual = startedAt(record.pid)
    // A different start time means the PID now belongs to another process.
    if (actual !== null && Math.abs(actual - record.startedAtMs) > 5000) {
      return null
    }
  }
  return `Orca is running (process ${record.pid})`
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function run(program, args) {
  try {
    return execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

function processName(pid) {
  const output =
    process.platform === 'win32'
      ? run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
      : // The command line, not comm: Linux shows a node process's main thread name there.
        run('ps', ['-p', String(pid), '-o', 'args='])
  return output?.trim() || null
}

function processStartedAtMs(pid) {
  const output =
    process.platform === 'win32'
      ? run('powershell', [
          '-NoProfile',
          '-Command',
          `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`
        ])
      : run('ps', ['-p', String(pid), '-o', 'lstart='])
  const ms = output ? Date.parse(output.trim()) : Number.NaN
  return Number.isFinite(ms) ? ms : null
}

function linuxIncarnation(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // Field 22, counted after the parenthesised command name, which may hold spaces.
    const startTicks = stat
      .slice(stat.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/)[19]
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    return startTicks && bootId ? { startTicks, bootId } : null
  } catch {
    return null
  }
}

/** The same machine identity Orca writes into orcad.lock. */
function machineIdentity() {
  if (process.platform === 'linux') {
    try {
      return readFileSync('/etc/machine-id', 'utf8').trim() || null
    } catch {
      return null
    }
  }
  if (process.platform === 'win32') {
    const guid = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(
      run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']) ?? ''
    )?.[1]
    return guid ? `win32-machine-guid:${guid.toLowerCase()}` : null
  }
  return (
    /"IOPlatformUUID"\s*=\s*"([^"]*)"/
      .exec(run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']) ?? '')?.[1]
      ?.toLowerCase() ?? null
  )
}
