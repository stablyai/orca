// A tools-file server entry's keys beyond the tools schema, kept across writes as they are; the
// host MCP list keeps its own per-server fields there.
import type { BotToolServer } from '../../shared/bot-tools'

const KNOWN_KEYS = ['name', 'url', 'transport', 'headers', 'credential', 'command', 'args', 'env']

/** A server with the keys its entry carries beyond the tools schema. */
export type BotToolEntry = { server: BotToolServer; extras: Record<string, unknown> }

export const botToolEntryExtras = (
  stored: Record<string, unknown> | undefined
): Record<string, unknown> =>
  Object.fromEntries(Object.entries(stored ?? {}).filter(([key]) => !KNOWN_KEYS.includes(key)))
