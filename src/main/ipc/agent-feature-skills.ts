import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ipcMain } from 'electron'
import {
  AGENT_FEATURE_SKILL_COMMANDS,
  AGENT_FEATURE_SKILL_INSTALL_ARGS,
  isAgentFeatureSkillId,
  type AgentFeatureSkillId,
  type AgentFeatureSkillInstallResult,
  type AgentFeatureSkillInstallSummary
} from '../../shared/agent-feature-install-commands'

const execFileAsync = promisify(execFile)
const SKILL_INSTALL_TIMEOUT_MS = 120_000

export function registerAgentFeatureSkillHandlers(): void {
  ipcMain.handle(
    'agentFeatureSkills:install',
    async (_event, args: { skillIds?: unknown }): Promise<AgentFeatureSkillInstallSummary> => {
      const skillIds = parseSkillIds(args?.skillIds)
      const results: AgentFeatureSkillInstallResult[] = []
      for (const skillId of skillIds) {
        results.push(await installAgentFeatureSkill(skillId))
      }
      return { results }
    }
  )
}

function parseSkillIds(input: unknown): AgentFeatureSkillId[] {
  if (!Array.isArray(input)) {
    return []
  }
  const uniqueSkillIds: AgentFeatureSkillId[] = []
  for (const item of input) {
    if (!isAgentFeatureSkillId(item) || uniqueSkillIds.includes(item)) {
      continue
    }
    uniqueSkillIds.push(item)
  }
  return uniqueSkillIds
}

async function installAgentFeatureSkill(
  skillId: AgentFeatureSkillId
): Promise<AgentFeatureSkillInstallResult> {
  const command = AGENT_FEATURE_SKILL_COMMANDS[skillId]
  const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  try {
    await execFileAsync(executable, [...AGENT_FEATURE_SKILL_INSTALL_ARGS[skillId]], {
      timeout: SKILL_INSTALL_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    })
    return { skillId, command, ok: true, detail: null }
  } catch (error) {
    console.error('[agent-feature-skills] Failed to install skill', {
      skillId,
      error
    })
    return {
      skillId,
      command,
      ok: false,
      detail: 'Skill install failed. Run the command manually from Settings.'
    }
  }
}
