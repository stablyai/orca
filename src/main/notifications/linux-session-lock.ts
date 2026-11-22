import { runProcess, spawnProcess } from '@orca/process-host'
import { createInterface } from 'node:readline'

const LOGIN = 'org.freedesktop.login1'
const MANAGER_PATH = '/org/freedesktop/login1'
const SESSION = `${LOGIN}.Session`
const PROPERTIES = 'org.freedesktop.DBus.Properties'

// Orca owns the stdin writer, and only gdbus holds stdout after setup.
const LOGIND_MONITOR_SCRIPT = `trap 'kill %1 2>/dev/null || :; wait' EXIT
trap 'exit' HUP INT TERM
gdbus monitor --system --dest "$1" </dev/null &
exec 1>&-
IFS= read -r _ || :`

async function callLogind(
  path: string,
  method: string,
  args: string[],
  signal: AbortSignal
): Promise<string | undefined> {
  try {
    const result = await runProcess({
      program: 'gdbus',
      args: [
        'call',
        '--system',
        '--dest',
        LOGIN,
        '--timeout',
        '1',
        '-o',
        path,
        '-m',
        method,
        ...args
      ],
      maxOutputBytes: 4_096,
      timeoutMs: 1_500,
      signal
    })
    if (result.code === 0 && !result.timedOut) {
      return result.stdout.trim()
    }
  } catch {
    // The system bus, logind or gdbus may be unavailable.
  }
  return undefined
}

async function resolveGraphicalSession(signal: AbortSignal): Promise<string | undefined> {
  const sessionId = process.env.XDG_SESSION_ID
  const lookups = [{ method: 'GetSessionByPID', argument: String(process.pid) }]
  // Desktop launchers can run Orca in a user scope outside the logind session cgroup.
  if (sessionId && /^[a-zA-Z0-9]+$/.test(sessionId)) {
    lookups.push({ method: 'GetSession', argument: sessionId })
  }
  for (const { method, argument } of lookups) {
    const result = await callLogind(MANAGER_PATH, `${LOGIN}.Manager.${method}`, [argument], signal)
    const path = result?.match(
      /^\(objectpath '(\/org\/freedesktop\/login1\/session\/[\w]+)',\)$/
    )?.[1]
    if (path) {
      const type = await callLogind(path, `${PROPERTIES}.Get`, [SESSION, 'Type'], signal)
      if (type && /^\(<'(?:wayland|x11|mir)'>,\)$/.test(type)) {
        return path
      }
    }
  }
  return undefined
}

export function watchLinuxSessionLock(onLocked: (locked: boolean) => void): () => void {
  if (process.platform !== 'linux') {
    return () => {}
  }

  const controller = new AbortController()
  const { signal } = controller
  void resolveGraphicalSession(signal).then((path) => {
    if (path && !signal.aborted) {
      monitorSession(path, controller, onLocked)
    }
  })
  return () => controller.abort()
}

function monitorSession(
  path: string,
  controller: AbortController,
  onLocked: (locked: boolean) => void
): void {
  let child: ReturnType<typeof spawnProcess>
  try {
    child = spawnProcess({
      program: '/bin/sh',
      args: ['-c', LOGIND_MONITOR_SCRIPT, 'orca-logind-monitor', LOGIN],
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['pipe', 'pipe', 'ignore']
    })
  } catch {
    return
  }

  const { signal } = controller
  const lines = createInterface({ input: child.stdout! })
  const stop = (): void => {
    lines.close()
    child.stdin?.destroy()
  }
  const unavailable = (): void => {
    if (!signal.aborted) {
      controller.abort()
      onLocked(false)
    }
  }
  signal.addEventListener('abort', stop, { once: true })
  child.once('error', unavailable)
  child.once('close', unavailable)
  child.stdin?.on('error', unavailable)
  lines.once('close', unavailable)
  lines.on('error', unavailable)
  if (signal.aborted) {
    stop()
    return
  }

  let revision = 0
  const readLockedHint = async (): Promise<void> => {
    const pending = ++revision
    const result = await callLogind(path, `${PROPERTIES}.Get`, [SESSION, 'LockedHint'], signal)
    // A newer signal supersedes a snapshot still in flight.
    if (!signal.aborted && pending === revision) {
      onLocked(result === '(<true>,)')
    }
  }

  const propertiesChanged = `${path}: ${PROPERTIES}.PropertiesChanged ('${SESSION}', `
  const sessionRemoved = `${MANAGER_PATH}: ${LOGIN}.Manager.SessionRemoved (`
  lines.on('line', (line) => {
    if (signal.aborted) {
      return
    }
    if (line.startsWith(propertiesChanged)) {
      const hint = line.slice(propertiesChanged.length).match(/'LockedHint': <(true|false)>/)
      if (hint) {
        revision++
        onLocked(hint[1] === 'true')
      } else if (line.includes("'LockedHint'")) {
        void readLockedHint()
      }
    } else if (line.startsWith(`The name ${LOGIN} is owned by `)) {
      void readLockedHint()
    } else if (line === `The name ${LOGIN} does not have an owner`) {
      revision++
      onLocked(false)
    } else if (line.startsWith(sessionRemoved) && line.endsWith(`, objectpath '${path}')`)) {
      unavailable()
    }
  })
}
