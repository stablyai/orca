// Where each Google account's checks left off (Gmail history point, each calendar's sync token), and
// since when each bot has listened on an account. No secrets. It sits beside this runtime's own data,
// not with the shared sign-ins: another Orca on this machine (orca serve, a dev build) has its own
// rules and must not prune these.
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { writeFileAtomically } from '../filesystem/atomic-file-publication'
import { getDataFile } from '../persistence/loading-store/user-data-path'

const StateSchema = z.object({
  accounts: z
    .record(
      z.string(),
      z.object({
        historyId: z.string().optional(),
        calendars: z.record(z.string(), z.object({ syncToken: z.string().optional() })).optional()
      })
    )
    .default({}),
  /** `${botId} ${account}` to when that bot began listening there: older mail never starts it. */
  listeners: z.record(z.string(), z.number()).default({})
})

export type GoogleTriggerState = z.infer<typeof StateSchema>

export const googleTriggerStatePath = () =>
  join(dirname(getDataFile()), 'orca-google-triggers.json')

export const listenerKey = (botId: string, account: string) => `${botId} ${account}`

export function readGoogleTriggerState(path = googleTriggerStatePath()): GoogleTriggerState {
  try {
    const parsed = StateSchema.safeParse(JSON.parse(readFileSync(path, 'utf-8')))
    if (parsed.success) {
      return parsed.data
    }
  } catch {
    // Nothing saved yet, or unreadable: start from now.
  }
  return { accounts: {}, listeners: {} }
}

export function writeGoogleTriggerState(
  state: GoogleTriggerState,
  path = googleTriggerStatePath()
): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileAtomically(path, `${JSON.stringify(state)}\n`)
}
