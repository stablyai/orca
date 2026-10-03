import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import { collectHookListings, type CodexHookListing } from './codex-app-server-client'
import { runCodexAppServerSession } from './codex-app-server-session'
import { CODEX_EVENTS, CODEX_EVENT_LABEL } from './codex-hook-definition'
import {
  buildCodexHookDefinitionFlag,
  CODEX_REQUIRED_EVENTS,
  type CodexHookSessionTrust
} from './codex-hook-session-flags'

// Why: an app-server start with a cold sqlite takes ~4 s; this bounds a hung binary.
const DERIVE_TIMEOUT_MS = 30_000

/** Codex's key and hash for each event of `hookCommand`, asked in a throwaway CODEX_HOME. */
export async function askCodexForHookSessionTrust(
  codexCommand: string,
  hookCommand: string
): Promise<CodexHookSessionTrust | null> {
  const definition = buildCodexHookDefinitionFlag(hookCommand)
  if (!definition) {
    return null
  }
  const listings = await listSessionFlagHooks(codexCommand, definition)
  return readSessionFlagTrust(listings, hookCommand)
}

/**
 * Whether Codex lists every required event of the complete flag (definition
 * plus approval), and every other event it lists at all, as trusted and enabled.
 */
export async function codexTrustsHookSessionFlag(
  codexCommand: string,
  flag: string,
  hookCommand: string
): Promise<boolean> {
  const listings = await listSessionFlagHooks(codexCommand, flag)
  return CODEX_EVENTS.every((eventName) => {
    const matches = matchSessionFlagEvent(listings, hookCommand, CODEX_EVENT_LABEL[eventName])
    if (matches.length === 0 && !CODEX_REQUIRED_EVENTS.includes(eventName)) {
      return true
    }
    return (
      matches.length === 1 && matches[0].trustStatus === 'trusted' && matches[0].enabled === true
    )
  })
}

async function listSessionFlagHooks(
  codexCommand: string,
  flag: string
): Promise<CodexHookListing[]> {
  // Why a throwaway home: Codex computes the hash with no file or position in it,
  // so the answer holds for every home, and no real home is read or written.
  const scratchHome = await mkdtemp(join(tmpdir(), 'orca-codex-hook-trust-'))
  try {
    const listing = await runCodexAppServerSession(
      {
        command: codexCommand,
        // Why the probe args: plugin startup can leave marketplace clones behind a short session.
        args: ['-c', flag, ...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS],
        cliPath: codexCommand,
        env: { CODEX_HOME: scratchHome },
        timeoutMs: DERIVE_TIMEOUT_MS
      },
      (rpc) => rpc.request('hooks/list', { cwds: [scratchHome] })
    )
    return collectHookListings(listing)
  } finally {
    await rm(scratchHome, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
}

function matchSessionFlagEvent(
  listings: readonly CodexHookListing[],
  hookCommand: string,
  label: string
): CodexHookListing[] {
  return listings.filter(
    (listing) =>
      listing.source === 'sessionFlags' &&
      listing.command === hookCommand &&
      listing.key.endsWith(`:${label}:0:0`)
  )
}

/**
 * Codex's key and hash per managed event, or null unless every required event
 * is reported once. An optional event this Codex does not list is left out.
 */
export function readSessionFlagTrust(
  listings: readonly CodexHookListing[],
  hookCommand: string
): CodexHookSessionTrust | null {
  const record: Record<string, { key: string; trustedHash: string }> = {}
  for (const eventName of CODEX_EVENTS) {
    const label = CODEX_EVENT_LABEL[eventName]
    const matches = matchSessionFlagEvent(listings, hookCommand, label)
    if (matches.length === 0 && !CODEX_REQUIRED_EVENTS.includes(eventName)) {
      continue
    }
    if (matches.length !== 1) {
      return null
    }
    record[label] = { key: matches[0].key, trustedHash: matches[0].currentHash }
  }
  return record
}
