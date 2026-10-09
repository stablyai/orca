import { basename, posix } from 'node:path'
import { describeClaudeProfile, type ClaudeProfileDescriptor } from './claude-profile-paths'

/** A WSL account folder in the guest: the one spelling setup, launch and sign-in use. */
export function wslClaudeProfile(
  guestHome: string,
  distro: string,
  accountId: string
): { dataRoot: string; profile: ClaudeProfileDescriptor } {
  const dataRoot = posix.join(guestHome, '.local/share/orca')
  const profile = describeClaudeProfile(dataRoot, accountId, {
    executionHostId: 'local',
    runtime: 'wsl',
    distro
  })
  return { dataRoot, profile }
}

/**
 * The guest's which-account file, relative to the guest home: a pane spawn cannot ask the guest
 * for its home, so the pane value is `~/` plus this and the `claude` function expands it. Named
 * after the host data folder so a dev build and the packaged app never share one.
 */
export function wslClaudeProfilePointer(hostDataRoot: string): string {
  const build = basename(hostDataRoot).replace(/[^\w.-]/g, '_')
  return `.local/share/orca/claude-profiles/selected-wsl-${build}`
}

/** A saved WSL account's guest folder; null for an older Orca's folder, which holds no login. */
export function savedWslClaudeAccountHome(account: {
  id: string
  wslLinuxAuthPath?: string | null
}): string | null {
  const home = account.wslLinuxAuthPath
  return home?.endsWith(`/claude-profiles/${account.id}/home`) ? home : null
}
