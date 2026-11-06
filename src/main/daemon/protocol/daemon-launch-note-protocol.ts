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

export function parseDaemonLaunchNoteChange(raw: unknown): DaemonLaunchNoteChange | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const { arm, retire } = raw as Record<string, unknown>
  if (isString(retire)) {
    return { retire }
  }
  const note = parseDaemonLaunchNote(arm)
  return note ? { arm: note } : null
}

function parseDaemonLaunchNote(raw: unknown): DaemonLaunchNote | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const { launchToken, launchConfig: config } = raw as Record<string, unknown>
  if (!isString(launchToken) || launchToken.length === 0 || launchToken.length > 128) {
    return null
  }
  if (!config || typeof config !== 'object') {
    return null
  }
  const { agentArgs, agentEnv, agentCommand, ompResumeFilePath } = config as Record<string, unknown>
  if (
    !isString(agentArgs) ||
    !agentEnv ||
    typeof agentEnv !== 'object' ||
    !Object.values(agentEnv).every(isString) ||
    (agentCommand !== undefined && !isString(agentCommand)) ||
    (ompResumeFilePath !== undefined && !isString(ompResumeFilePath))
  ) {
    return null
  }
  return {
    launchToken,
    launchConfig: {
      agentArgs,
      agentEnv: { ...(agentEnv as Record<string, string>) },
      ...(agentCommand ? { agentCommand } : {}),
      ...(ompResumeFilePath ? { ompResumeFilePath } : {})
    }
  }
}
