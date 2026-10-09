import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { canCopyClaudeSignInLink, isClaudeLocalSignInLink } from '../../shared/claude-sign-in-link'
import type { ClaudeCommandConfig } from './claude-command-process'

const HELPER_NAME = '.orca-sign-in-browser'
const LINK_SUFFIX = '.link'
const POLL_INTERVAL_MS = 250
// Why a file: Claude discards BROWSER's output, and the link it prints itself needs a pasted code.
const HELPER_SCRIPT = `#!/bin/sh\nprintf '%s' "$1" > "$0.tmp" && mv "$0.tmp" "$0${LINK_SUFFIX}"\n`

export type ClaudeSignInBrowser = {
  /** BROWSER as the Claude process sees it. */
  path: string
  /** The localhost-callback link Claude handed BROWSER; null if stopped first or not a sign-in link. */
  nextLink: (signal: AbortSignal) => Promise<string | null>
  dispose: () => Promise<void>
}

/** A BROWSER stand-in in the account's folder that hands Claude's sign-in link to Orca instead of
 *  opening it; null where Claude's host cannot run it. */
export async function prepareClaudeSignInBrowser(
  folder: ClaudeCommandConfig
): Promise<ClaudeSignInBrowser | null> {
  const isWsl = folder.linuxPath !== null && folder.wslDistro !== null
  if (!canCopyClaudeSignInLink(process.platform === 'win32', isWsl ? 'wsl' : 'host')) {
    return null
  }
  const helperPath = join(folder.windowsPath, HELPER_NAME)
  const linkPath = `${helperPath}${LINK_SUFFIX}`
  const dispose = async (): Promise<void> => {
    await Promise.all(
      [helperPath, linkPath, `${helperPath}.tmp`].map((path) => rm(path, { force: true }))
    )
  }
  await dispose()
  await writeFile(helperPath, HELPER_SCRIPT, { mode: 0o700 })
  return {
    path: isWsl && folder.linuxPath ? posix.join(folder.linuxPath, HELPER_NAME) : helperPath,
    nextLink: (signal) => pollForLink(linkPath, signal),
    dispose
  }
}

function pollForLink(linkPath: string, signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const stop = (signInLink: string | null): void => {
      if (timer) {
        clearTimeout(timer)
      }
      signal.removeEventListener('abort', onAbort)
      resolve(signInLink)
    }
    const onAbort = (): void => stop(null)
    const poll = (): void => {
      readFile(linkPath, 'utf8').then(
        (signInLink) => {
          if (signal.aborted) {
            return
          }
          const trimmed = signInLink.trim()
          if (!isClaudeLocalSignInLink(trimmed)) {
            console.warn('[claude-accounts] Claude handed BROWSER an unexpected sign-in link.')
            stop(null)
            return
          }
          stop(trimmed)
        },
        () => {
          if (!signal.aborted) {
            timer = setTimeout(poll, POLL_INTERVAL_MS)
          }
        }
      )
    }
    if (signal.aborted) {
      resolve(null)
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    poll()
  })
}
