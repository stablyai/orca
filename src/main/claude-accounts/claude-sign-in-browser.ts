import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  CLAUDE_SIGN_IN_FAILED_MESSAGE,
  canCopyClaudeSignInLink
} from '../../shared/claude-sign-in-link'
import type { ClaudeCommandConfig } from './claude-command-process'

const HELPER_NAME = '.orca-sign-in-browser'
const LINK_SUFFIX = '.link'
const POLL_INTERVAL_MS = 250
// Why a deadline: Claude runs BROWSER as soon as it listens, so silence means it never ran.
const LINK_WAIT_MS = 60_000
// Why a file: Claude discards BROWSER's output, and the link it prints itself needs a pasted code.
const HELPER_SCRIPT = `#!/bin/sh\nprintf '%s' "$1" > "$0.tmp" && mv "$0.tmp" "$0${LINK_SUFFIX}"\n`
const CLAUDE_AUTHORIZE_HOSTS = new Set(['claude.com', 'claude.ai'])
const LOCAL_CALLBACK_HOSTS = new Set(['localhost', '127.0.0.1'])

export type ClaudeSignInBrowser = {
  /** BROWSER as the Claude process sees it. */
  path: string
  /** The localhost-callback link Claude handed BROWSER; null if stopped, late, or not one. */
  nextLink: (signal: AbortSignal) => Promise<string | null>
  dispose: () => Promise<void>
}

/** Claude's sign-in link that calls back to this computer, never the pasted-code one it prints. */
export function isClaudeLocalSignInLink(signInLink: string): boolean {
  try {
    const url = new URL(signInLink)
    const redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
    return (
      url.protocol === 'https:' &&
      CLAUDE_AUTHORIZE_HOSTS.has(url.hostname) &&
      redirect.protocol === 'http:' &&
      LOCAL_CALLBACK_HOSTS.has(redirect.hostname)
    )
  } catch {
    return false
  }
}

/** A BROWSER stand-in in the account's folder that hands Claude's sign-in link to Orca instead of
 *  opening it. */
export async function prepareClaudeSignInBrowser(
  folder: ClaudeCommandConfig
): Promise<ClaudeSignInBrowser> {
  const isWsl = folder.linuxPath !== null && folder.wslDistro !== null
  if (!canCopyClaudeSignInLink(process.platform === 'win32', isWsl ? 'wsl' : 'host')) {
    throw new Error(CLAUDE_SIGN_IN_FAILED_MESSAGE)
  }
  const helperPath = join(folder.windowsPath, HELPER_NAME)
  const linkPath = `${helperPath}${LINK_SUFFIX}`
  const dispose = async (): Promise<void> => {
    await Promise.all(
      [helperPath, linkPath, `${helperPath}.tmp`].map((path) => rm(path, { force: true }))
    )
  }
  try {
    await dispose()
    await writeFile(helperPath, HELPER_SCRIPT, { mode: 0o700 })
  } catch (error) {
    console.warn('[claude-accounts] Could not prepare the Claude sign-in browser:', error)
    await dispose().catch(() => {})
    throw new Error(CLAUDE_SIGN_IN_FAILED_MESSAGE)
  }
  return {
    path: isWsl && folder.linuxPath ? posix.join(folder.linuxPath, HELPER_NAME) : helperPath,
    nextLink: (signal) => pollForLink(linkPath, signal),
    dispose
  }
}

async function pollForLink(linkPath: string, signal: AbortSignal): Promise<string | null> {
  const deadline = Date.now() + LINK_WAIT_MS
  while (!signal.aborted && Date.now() < deadline) {
    const signInLink = await readFile(linkPath, 'utf8').then(
      (text) => text.trim(),
      () => null
    )
    if (signInLink !== null) {
      if (isClaudeLocalSignInLink(signInLink)) {
        return signInLink
      }
      console.warn('[claude-accounts] Claude handed BROWSER an unexpected sign-in link.')
      return null
    }
    await delay(POLL_INTERVAL_MS, undefined, { signal }).catch(() => {})
  }
  return null
}
