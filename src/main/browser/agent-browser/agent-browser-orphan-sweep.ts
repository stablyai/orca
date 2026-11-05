import { runProcess } from '@orca/process-host'

export const ORCA_TAB_SESSION_PREFIX = 'orca-tab-'

const SWEEP_TIMEOUT_MS = 5_000
const SWEEP_MAX_OUTPUT_BYTES = 256 * 1024

type SessionListEnvelope = {
  data?: { sessions?: unknown }
}

function parseSessionNames(stdout: string): string[] {
  let envelope: SessionListEnvelope
  try {
    envelope = JSON.parse(stdout) as SessionListEnvelope
  } catch {
    return []
  }
  const sessions = envelope?.data?.sessions
  if (!Array.isArray(sessions)) {
    return []
  }
  return sessions.filter((name): name is string => typeof name === 'string' && name.length > 0)
}

/** Sweep only this profile's owned socket directory; inherited paths and Windows pipes may be shared. */
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
    listed = result.timedOut ? [] : parseSessionNames(result.stdout)
  } catch {
    return []
  }

  const closed: string[] = []
  for (const sessionName of listed) {
    if (!sessionName.startsWith(ORCA_TAB_SESSION_PREFIX) || options.isSessionLive?.(sessionName)) {
      continue
    }
    try {
      await runProcess({
        program: options.binaryPath,
        args: ['--session', sessionName, 'close'],
        env: options.env,
        timeoutMs: SWEEP_TIMEOUT_MS,
        maxOutputBytes: SWEEP_MAX_OUTPUT_BYTES
      })
      closed.push(sessionName)
    } catch {}
  }
  return closed
}
