// A text task runs on the chat's own home, or, for an agent that keeps every session, on a home of
// its own that is removed with everything the agent kept there (`AcpLaunchSpec.textTaskHome`).

import { join } from 'node:path'
import type { AgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { StructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import { acpLaunchSpecForAccount } from '../launch/acp-launch-command'
import { acpRunFolder, wipeRootOnce } from '../launch/acp-private-temp'
import { prepareAcpLaunch } from '../launch/acp-structured-launch-preparation'
import {
  resolveAcpLaunchInvocation,
  type AcpLaunchInvocation,
  type AcpLaunchInvocationDeps
} from '../launch/acp-structured-launch-resolution'

/** Under Orca's data folder: per-agent run homes for `AcpLaunchSpec.textTaskHome`. */
const TEXT_TASK_HOMES_FOLDER = 'acp-text-task-homes'

const homesRoot = (dataDirectory: string, agent: string): string =>
  join(dataDirectory, TEXT_TASK_HOMES_FOLDER, agent)

/** At launch, whatever the naming settings: a run a crash cut short left its home, which may hold
 *  a copy of the agent's login. */
export function sweepAcpTextTaskHomes(
  dataDirectory: string,
  specs: readonly Pick<AcpLaunchSpec, 'agent' | 'textTaskHome'>[]
): void {
  for (const spec of specs) {
    if (spec.textTaskHome) {
      void wipeRootOnce(homesRoot(dataDirectory, spec.agent))
    }
  }
}

export type AcpTextTaskLaunch = {
  /** The prepared launch; null when the task's home declines to run it. */
  prepare(
    invocation: AcpLaunchInvocationDeps,
    closedBeforeSpawn: () => void
  ): Promise<AcpLaunchInvocation | null>
  /** Call once the agent has exited (or never spawned): its home goes after preparation settles,
   *  since a preparation the deadline stopped waiting for can still write into it. */
  release(): void
}

/** Null for an agent whose session would stay in the user's own history. */
export async function acpTextTaskLaunch(
  spec: AcpLaunchSpec,
  chatHome: AgentSessionAccountHome,
  deps: { dataDirectory: string; logger?: StructuredAgentSessionLogger }
): Promise<AcpTextTaskLaunch | null> {
  if (!acpLaunchSpecForAccount(spec, chatHome).keepsEverySession) {
    return {
      prepare: (invocation, closedBeforeSpawn) =>
        prepareAcpLaunch(
          () => resolveAcpLaunchInvocation(spec, chatHome, invocation),
          closedBeforeSpawn
        ),
      release: () => {}
    }
  }
  if (!spec.textTaskHome) {
    return null
  }
  const folder = await acpRunFolder(homesRoot(deps.dataDirectory, spec.agent), deps.logger)
  const task = spec.textTaskHome(chatHome, folder.path)
  if (!task) {
    await folder.remove()
    return null
  }
  let preparation: Promise<unknown> = Promise.resolve()
  return {
    prepare: (invocation, closedBeforeSpawn) => {
      let declined = false
      const preparing = prepareAcpLaunch(async () => {
        const resolved = await resolveAcpLaunchInvocation(task.spec, task.home, invocation)
        if (!(await task.admits(resolved))) {
          declined = true
          throw new Error('The text task was declined')
        }
        return resolved
      }, closedBeforeSpawn)
      preparation = preparing.catch(() => undefined)
      return preparing.catch((error: unknown) => {
        if (declined) {
          return null
        }
        throw error
      })
    },
    release: () => void preparation.then(() => folder.remove())
  }
}
