import type { AgentSessionSlashCommand } from '../../shared/agent-session/agent-session-wire'
import { traexRecord, traexText } from './traex-protocol'

export async function readTraexSessionCommands(
  connection: {
    request(method: string, params?: Record<string, unknown>): Promise<unknown>
  },
  cwd: string,
  forceReload = false
): Promise<AgentSessionSlashCommand[]> {
  const response = traexRecord(
    await connection.request('skills/list', { cwds: [cwd], forceReload })
  )
  const folders = Array.isArray(response.data) ? response.data.map(traexRecord) : []
  const folder = folders.find((entry) => entry.cwd === cwd) ?? folders[0]
  if (!folder || !Array.isArray(folder.skills)) {
    throw new Error('TRAE CLI did not return a folder skill catalog')
  }
  return folder.skills.flatMap((value): AgentSessionSlashCommand[] => {
    const skill = traexRecord(value)
    const name = traexText(skill.name)
    const path = traexText(skill.path)
    if (!name || !path || skill.enabled === false) {
      return []
    }
    const description =
      traexText(traexRecord(skill.interface).shortDescription) ??
      traexText(skill.shortDescription) ??
      traexText(skill.description)
    return [{ name, kind: 'skill', path, ...(description ? { description } : {}) }]
  })
}
