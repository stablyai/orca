import { runProcess } from '@orca/process-host'
import { ORCA_TAB_SESSION_PREFIX } from './agent-browser-session-name'
import {
  canSkipAgentBrowserSessionReset,
  waitForAgentBrowserSessionExit
} from './agent-browser-session-reset'

const SWEEP_TIMEOUT_MS = 5_000
const SWEEP_MAX_OUTPUT_BYTES = 256 * 1024

type SessionListEnvelope = {
  success?: boolean
  data?: { sessions?: unknown }
}

function parseSessionNames(stdout: string): string[] | null {
  let envelope: SessionListEnvelope
  try {
    envelope = JSON.parse(stdout) as SessionListEnvelope
  } catch {
    return null
  }
  const sessions = envelope?.data?.sessions
  if (envelope?.success === false || !Array.isArray(sessions)) {
    return null
  }
  return sessions.filter((name): name is string => typeof name === 'string' && name.length > 0)
}

/** Return sessions whose close succeeded and owned socket disappeared; this does not verify a PID. */
export async function sweepOrphanedAgentBrowserSessions(options: {
  binaryPath: string
  env: NodeJS.ProcessEnv
  ownsSocketDirectory: boolean
  isSessionLive?: (sessionName: string) => boolean
}): Promise<string[]> {
  if (!options.ownsSocketDirectory || process.env.ORCA_DISABLE_AGENT_BROWSER_SWEEP === '1') {
    return []
  }
  let listed: string[]
  try {
    const result = await runProcess({
      program: options.binaryPath,
      args: ['session', 'list', '--json'],
      env: options.env,
      timeoutMs: SWEEP_TIMEOUT_MS,
      maxOutputBytes: SWEEP_MAX_OUTPUT_BYTES
    })
    if (result.timedOut) {
      console.warn('[agent-browser] Orphan session listing timed out')
      return []
    }
    if (result.code !== 0 || result.signal !== null) {
      console.warn('[agent-browser] Orphan session listing failed')
      return []
    }
    const sessions = parseSessionNames(result.stdout)
    if (!sessions) {
      console.warn('[agent-browser] Orphan session listing returned an invalid response')
      return []
    }
    listed = sessions
  } catch {
    console.warn('[agent-browser] Orphan session listing failed')
    return []
  }

  const closed: string[] = []
  for (const sessionName of listed) {
    if (!sessionName.startsWith(ORCA_TAB_SESSION_PREFIX) || options.isSessionLive?.(sessionName)) {
      continue
    }
    try {
      const result = await runProcess({
        program: options.binaryPath,
        args: ['--session', sessionName, 'close'],
        env: options.env,
        timeoutMs: SWEEP_TIMEOUT_MS,
        maxOutputBytes: SWEEP_MAX_OUTPUT_BYTES
      })
      if (result.timedOut) {
        console.warn('[agent-browser] Orphan session close timed out')
        continue
      }
      if (result.code !== 0 || result.signal !== null) {
        console.warn('[agent-browser] Orphan session close failed')
        continue
      }
      const exitOptions = {
        ownsSocketDirectory: options.ownsSocketDirectory,
        socketDirectory: options.env.AGENT_BROWSER_SOCKET_DIR,
        sessionName
      }
      await waitForAgentBrowserSessionExit(exitOptions)
      if (!canSkipAgentBrowserSessionReset(exitOptions)) {
        console.warn('[agent-browser] Orphan session close could not be verified')
        continue
      }
      closed.push(sessionName)
    } catch {
      console.warn('[agent-browser] Orphan session close failed')
    }
  }
  return closed
}
