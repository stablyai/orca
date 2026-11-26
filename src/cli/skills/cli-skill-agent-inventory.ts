import { forkProcess } from '@orca/process-host/fork-process'
import {
  AgentInventoryDeadlineError,
  INVENTORY_COMPLETION_WAIT_MS
} from '../../main/skills/bundled-skill-install/bundled-skill-local-host'
import {
  isSkillInstallProviderId,
  type SkillInstallProviderId
} from '../../shared/skills/installation/skill-install-providers'

export { sendCliSkillAgentInventory } from '../../main/skills/bundled-skill-install/bundled-skill-local-host'

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
  const { promise, resolve, reject } = Promise.withResolvers<SkillInstallProviderId[]>()
  child.once('error', reject)
  child.once('exit', () => reject(new Error('Could not complete local agent inventory')))
  child.once('message', (reply: unknown) => {
    if (Array.isArray(reply) && reply.every(isSkillInstallProviderId)) {
      resolve(reply)
    } else {
      reject(new Error(typeof reply === 'string' ? reply : 'Invalid local agent inventory'))
    }
  })
  const timer = setTimeout(
    () => reject(new AgentInventoryDeadlineError()),
    INVENTORY_COMPLETION_WAIT_MS
  )
  try {
    return await promise
  } finally {
    clearTimeout(timer)
    child.unref()
    child.channel?.unref()
    if (child.connected) {
      child.disconnect()
    }
    child.kill('SIGKILL')
  }
}
