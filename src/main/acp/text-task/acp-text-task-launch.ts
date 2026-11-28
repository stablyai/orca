// A text task runs on the chat's own home, or, for an agent that keeps every session, on a home of
// its own that is removed with everything the agent kept there (`AcpLaunchSpec.textTaskHome`).

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, realpath, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import { acpLaunchSpecForAccount } from '../launch/acp-launch-command'
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

// Run homes in use; anything else under a root is a leftover. Added before the folder exists, so a
// sweep never removes a home a run is creating.
const activeHomes = new Set<string>()

/** Removes a home; one a scanner holds open stays on disk and the next sweep tries again. */
async function removeHome(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (error) {
    console.warn('[acp-text-task] A text task home is left for the next sweep:', error)
  }
}

const RUN_HOME = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const isRealFolder = (path: string): Promise<boolean> =>
  lstat(path).then(
    (entry) => entry.isDirectory() && !entry.isSymbolicLink(),
    () => false
  )

/** The agent's root when it and its parent are real folders (no link or junction) that resolve
 *  inside the data folder; null otherwise, so nothing is removed through a link. */
async function realHomesRoot(dataDirectory: string, agent: string): Promise<string | null> {
  const root = homesRoot(dataDirectory, agent)
  const parent = join(dataDirectory, TEXT_TASK_HOMES_FOLDER)
  if (!(await isRealFolder(parent)) || !(await isRealFolder(root))) {
    return null
  }
  const [data, resolved] = await Promise.all([realpath(dataDirectory), realpath(root)]).catch(
    () => [null, null]
  )
  return data && resolved === join(data, TEXT_TASK_HOMES_FOLDER, agent) ? root : null
}

/** Removes every run home no run is using under the agent's root: a crash's, or one whose removal
 *  failed. Only `run-<uuid>` entries; a linked one loses the link, never what it points at. */
async function sweepRoot(dataDirectory: string, agent: string): Promise<void> {
  const root = await realHomesRoot(dataDirectory, agent)
  if (!root) {
    return
  }
  const names = await readdir(root).catch(() => [])
  await Promise.all(
    names.map(async (name) => {
      const path = join(root, name)
      if (!RUN_HOME.test(name) || activeHomes.has(path)) {
        return
      }
      const entry = await lstat(path).catch(() => null)
      if (entry?.isSymbolicLink()) {
        await unlink(path).catch(() => undefined)
      } else if (entry?.isDirectory()) {
        await removeHome(path)
      }
    })
  )
}

/** At every host start, whatever the naming settings, and before each run: a home left behind may
 *  hold a copy of the agent's login. */
export async function sweepAcpTextTaskHomes(
  dataDirectory: string,
  specs: readonly Pick<AcpLaunchSpec, 'agent' | 'textTaskHome'>[]
): Promise<void> {
  await Promise.all(
    specs.flatMap((spec) => (spec.textTaskHome ? [sweepRoot(dataDirectory, spec.agent)] : []))
  )
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
  deps: { dataDirectory: string }
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
  await mkdir(homesRoot(deps.dataDirectory, spec.agent), { recursive: true, mode: 0o700 })
  // A home made through a link would hold the login copy outside Orca's data folder.
  const root = await realHomesRoot(deps.dataDirectory, spec.agent)
  if (!root) {
    throw new Error("The text task homes folder isn't a plain folder in Orca's data folder")
  }
  await sweepRoot(deps.dataDirectory, spec.agent)
  const home = join(root, `run-${randomUUID()}`)
  activeHomes.add(home)
  let preparation: Promise<unknown> = Promise.resolve()
  const release = (): void => {
    void preparation.then(() => removeHome(home)).finally(() => activeHomes.delete(home))
  }
  try {
    await mkdir(home, { mode: 0o700 })
  } catch (error) {
    release()
    throw error
  }
  const task = spec.textTaskHome(chatHome, home)
  if (!task) {
    release()
    return null
  }
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
    release
  }
}
