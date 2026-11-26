import { forkProcess } from '@orca/process-host/fork-process'
import {
  isSkillInstallProviderId,
  type SkillInstallProviderId
} from '../../shared/skills/installation/skill-install-providers'

export const CLI_SKILL_AGENT_INVENTORY_ARG = '--internal-skill-agent-inventory'

export async function readCliSkillAgentInventory(
  entryPath: string
): Promise<SkillInstallProviderId[]> {
  // Node waits for native filesystem requests during exit, so the CLI leaves them in a child.
  const child = forkProcess({
    modulePath: entryPath,
    args: [CLI_SKILL_AGENT_INVENTORY_ARG],
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  })
  try {
    return await new Promise<SkillInstallProviderId[]>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', () => reject(new Error('Could not complete local agent inventory')))
      child.once('message', (reply: unknown) => {
        if (Array.isArray(reply) && reply.every(isSkillInstallProviderId)) {
          resolve(reply)
        } else {
          reject(new Error(typeof reply === 'string' ? reply : 'Invalid local agent inventory'))
        }
      })
    })
  } finally {
    child.unref()
    child.channel?.unref()
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }
}

export async function sendCliSkillAgentInventory(): Promise<void> {
  process.once('disconnect', () => process.kill(process.pid, 'SIGKILL'))
  try {
    const { detectInstalledAgentsWithShellPathHydration } =
      await import('../../main/preflight/installed-agent-detection.js')
    const agents = await detectInstalledAgentsWithShellPathHydration()
    process.send?.(agents.filter(isSkillInstallProviderId), () => {})
  } catch (error) {
    process.send?.(error instanceof Error ? error.message : String(error), () => {})
  }
}
