// Where the Teams mention check left off, and since when each bot has listened. No secrets. It sits
// beside this runtime's own data, like the Google trigger state: another Orca on this machine has its
// own rules.
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { writePluginFileAtomically } from '../plugins/installation/plugin-atomic-file-write'
import { getDataFile } from '../persistence/loading-store/user-data-path'

const StateSchema = z.object({
  /** The signed-in person the cursor is for; a different sign-in starts from now. */
  userId: z.string().optional(),
  /** Messages created before this (ms) were already looked at. */
  cursor: z.number().optional(),
  /** Bot id to when it began listening: older messages never start it. */
  listeners: z.record(z.string(), z.number()).default({}),
  /** Chat id to the part of a window still to read: past a page budget, or not taken by the run path. */
  backlog: z
    .record(
      z.string(),
      z.object({ from: z.number(), until: z.number(), topic: z.string().nullish() })
    )
    .optional(),
  /** The chat list's pages a budget stopped at, oldest first, each with the window it was read for. */
  chatsNext: z.array(z.object({ link: z.string(), from: z.number() })).optional()
})

export type TeamsTriggerState = z.infer<typeof StateSchema>

const statePath = () => join(dirname(getDataFile()), 'orca-teams-triggers.json')

export async function readTeamsTriggerState(path = statePath()): Promise<TeamsTriggerState> {
  try {
    const parsed = StateSchema.safeParse(JSON.parse(await readFile(path, 'utf-8')))
    if (parsed.success) {
      return parsed.data
    }
  } catch {
    // Nothing saved yet, or unreadable: start from now.
  }
  return { listeners: {} }
}

export async function writeTeamsTriggerState(
  state: TeamsTriggerState,
  path = statePath()
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writePluginFileAtomically(path, `${JSON.stringify(state)}\n`)
}
