// The AppImage runtime unmounts once every holder of its keepalive pipe exits, so on-mount helpers
// still exiting after main SIGBUS. Kill Crashpad; lend the pipe to an off-mount watcher that waits.
// Main-process crashes bypass exit hooks, so the handler may still fault after writing the dump.

import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
// posix: /proc paths are Linux-only, and tests run this matcher on every host.
import { posix } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import { resolveAppImageRuntimeIdentity } from './appimage-runtime-identity'

// Chromium children and Node helpers exit within ms of main; 10s bounds a wedged one's mount hold.
const HELPER_EXIT_DEADLINE_TICKS = 100
const O_ACCMODE = 0o3
const O_RDONLY = 0o0
const O_WRONLY = 0o1

/** $1 = 100ms ticks to wait, then pid=exe pairs. Never signals; `-ef` ignores a pid that exec'd or was reused. */
export const MOUNT_KEEPALIVE_SCRIPT = `ticks=$1; shift
alive() { for h; do [ /proc/"\${h%%=*}"/exe -ef "\${h#*=}" ] && return 0; done; return 1; }
n=0
while [ $n -lt "$ticks" ] && alive "$@"; do sleep 0.1 || exit; n=$((n+1)); done`

function listPids(): number[] {
  try {
    return readdirSync('/proc')
      .filter((entry) => /^\d+$/.test(entry))
      .map(Number)
  } catch {
    return []
  }
}

function readLink(path: string): string | null {
  try {
    return readlinkSync(path)
  } catch {
    return null
  }
}

function readSessionId(pid: number | 'self'): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // Fields after "(comm)": state ppid pgrp session.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[3] ?? null
  } catch {
    return null
  }
}

/** Pipe link -> fd, for pipe fds of `pid` opened with `accessMode`. */
function listPipeEnds(pid: number | 'self', accessMode: number): Map<string, number> {
  const ends = new Map<string, number>()
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      const link = readLink(`/proc/${pid}/fd/${fd}`)
      const flags = link?.startsWith('pipe:')
        ? /^flags:\s+([0-7]+)$/m.exec(readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8'))?.[1]
        : undefined
      if (link && flags !== undefined && (Number.parseInt(flags, 8) & O_ACCMODE) === accessMode) {
        ends.set(link, Number(fd))
      }
    }
  } catch {
    // An unreadable or exited process holds no usable end.
  }
  return ends
}

// type2-runtime: the FUSE server writes to a pipe whose read end it hands to the launched app.
function findKeepaliveFd(appImagePath: string): number | null {
  const readEnds = listPipeEnds('self', O_RDONLY)
  for (const pid of readEnds.size > 0 ? listPids() : []) {
    if (readLink(`/proc/${pid}/exe`) !== appImagePath) {
      continue
    }
    for (const link of listPipeEnds(pid, O_WRONLY).keys()) {
      const fd = readEnds.get(link)
      if (fd !== undefined) {
        return fd
      }
    }
  }
  return null
}

// Extract-and-run reuses one digest-named dir across concurrent launches and has no FUSE mount to lose.
function isRunningFromOwnMount(runtimeRoot: string): boolean {
  try {
    return statSync(runtimeRoot).dev !== statSync(posix.dirname(runtimeRoot)).dev
  } catch {
    return false
  }
}

/** Use Node's final exit phase because Electron can defer will-quit. */
export function installAppImageMountExit(): void {
  const runtimeRoot = posix.dirname(process.execPath)
  const identity = resolveAppImageRuntimeIdentity()
  // Validate now because the AppImage may be moved, replaced or deleted before exit.
  if (!identity || !isRunningFromOwnMount(runtimeRoot)) {
    return
  }
  let keepaliveFd: number | null = null
  try {
    keepaliveFd = findKeepaliveFd(realpathSync(identity.appImagePath))
  } catch {
    // Without the pipe, exit keeps today's unmount timing.
  }
  const handlerPath = posix.join(runtimeRoot, 'chrome_crashpad_handler')
  process.once('exit', () => {
    const sessionId = readSessionId('self')
    const helpers: string[] = []
    for (const pid of listPids()) {
      const executable = readLink(`/proc/${pid}/exe`)
      if (executable === handlerPath) {
        try {
          // SIGTERM runs handler code that may fault as FUSE unmounts; SIGKILL does not.
          process.kill(pid, 'SIGKILL')
        } catch {
          // The handler may already have exited.
        }
      } else if (
        keepaliveFd !== null &&
        sessionId !== null &&
        pid !== process.pid &&
        executable?.startsWith(`${runtimeRoot}/`) &&
        // Detached processes Orca keeps past quit (daemon, provider supervisors) run in their own session.
        readSessionId(pid) === sessionId
      ) {
        helpers.push(`${pid}=${executable}`)
      }
    }
    if (keepaliveFd === null || helpers.length === 0) {
      return
    }
    try {
      spawnProcess({
        program: '/bin/sh',
        args: [
          '-c',
          MOUNT_KEEPALIVE_SCRIPT,
          'orca-appimage-mount-keepalive',
          String(HELPER_EXIT_DEADLINE_TICKS),
          ...helpers
        ],
        cwd: '/',
        // AppRun points PATH and LD_LIBRARY_PATH into the mount this watcher must not depend on.
        env: { PATH: '/usr/bin:/bin' },
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', keepaliveFd]
      }).unref()
    } catch {
      // Without a watcher the runtime unmounts when main exits, as before.
    }
  })
}
