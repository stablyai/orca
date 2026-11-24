import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session/lifecycle/agent-session-resume'

/** The Orca launch running in a session, kept by the daemon so it outlives a main restart. */
export type DaemonLaunchNote = { launchToken: string; launchConfig: SleepingAgentLaunchConfig }

/** Main arms the launch it admits and retires it by token, so a stale retire cannot clear a newer launch. */
export type DaemonLaunchNoteChange = { arm: DaemonLaunchNote } | { retire: string }

export type SetLaunchNoteRequest = {
  id: string
  type: 'setLaunchNote'
  payload: { sessionId: string; change: DaemonLaunchNoteChange }
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null
const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every(isString)

export function parseDaemonLaunchNoteChange(raw: unknown): DaemonLaunchNoteChange | null {
  if (!isRecord(raw)) {
    return null
  }
  const { arm, retire } = raw
  if (isString(retire)) {
    return { retire }
  }
  const note = parseDaemonLaunchNote(arm)
  return note ? { arm: note } : null
}

function parseDaemonLaunchNote(raw: unknown): DaemonLaunchNote | null {
  if (!isRecord(raw)) {
    return null
  }
  const { launchToken, launchConfig: config } = raw
  if (!isString(launchToken) || launchToken.length === 0 || launchToken.length > 128) {
    return null
  }
  if (!isRecord(config)) {
    return null
  }
  const { agentArgs, agentEnv, agentCommand, ompResumeFilePath } = config
  if (
    !isString(agentArgs) ||
    !isStringRecord(agentEnv) ||
    (agentCommand !== undefined && !isString(agentCommand)) ||
    (ompResumeFilePath !== undefined && !isString(ompResumeFilePath))
  ) {
    return null
  }
  return {
    launchToken,
    launchConfig: {
      agentArgs,
      agentEnv: { ...agentEnv },
      ...(agentCommand ? { agentCommand } : {}),
      ...(ompResumeFilePath ? { ompResumeFilePath } : {})
    }
  }
}
