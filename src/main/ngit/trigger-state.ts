// Since when each bot has watched a repository, and which events already started something. Beside
// this runtime's own data: another Orca on this machine has its own rules.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { getDataFile } from '../persistence/loading-store/user-data-path'

const StateSchema = z.object({
  /** `${botId} ${repository}` to when that bot began listening: older events never start it. */
  listeners: z.record(z.string(), z.number()).default({}),
  /** `${automationId} ${event key}`, oldest first. */
  handled: z.array(z.string()).default([])
})

export type NgitTriggerState = z.infer<typeof StateSchema>

const ngitTriggerStatePath = () => join(dirname(getDataFile()), 'orca-ngit-triggers.json')

export async function readNgitTriggerState(
  path = ngitTriggerStatePath()
): Promise<NgitTriggerState> {
  try {
    const parsed = StateSchema.safeParse(JSON.parse(await readFile(path, 'utf-8')))
    if (parsed.success) {
      return parsed.data
    }
  } catch {
    // Nothing saved yet, or unreadable: start from now.
  }
  return { listeners: {}, handled: [] }
}

/** Renamed into place, so a crash never leaves a half-written file. One checker writes it. */
export async function writeNgitTriggerState(
  state: NgitTriggerState,
  path = ngitTriggerStatePath()
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(`${path}.tmp`, `${JSON.stringify(state)}\n`)
  await rename(`${path}.tmp`, path)
}
