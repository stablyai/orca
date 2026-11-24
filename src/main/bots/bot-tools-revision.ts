// Which version of a bot's tools a chat launched with, so a chat whose tools changed starts again at
// its next turn. A revision is an opaque digest; the epoch counts this host's own tool writes and
// finished sign-ins per bot folder (a login outside this Orca shows only through the file).
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const epochs = new Map<string, number>()

const key = (folder: string): string => resolve(folder)

export function botToolsEpoch(folder: string): number {
  return epochs.get(key(folder)) ?? 0
}

/** After a tools write or a sign-in that finished; never for one still pending or failed. */
export function advanceBotToolsEpoch(folder: string): void {
  epochs.set(key(folder), botToolsEpoch(folder) + 1)
}

export function forgetBotToolsEpoch(folder: string): void {
  epochs.delete(key(folder))
}

/** `version` is the tools file's own digest, never the saved values themselves. */
export function botToolsRevision(version: string, epoch: number): string {
  return createHash('sha256').update(`${version}\0${epoch}`).digest('hex')
}

/** What a launch read, from one snapshot, for the chat's later comparisons. */
export type BotLaunchedTools = { folder: string; revision: string; epoch: number }
