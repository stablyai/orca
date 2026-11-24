import type { Session } from 'electron'
import type {
  BrowserSitePermissionDecision,
  BrowserSitePermissionKey
} from '../../../../shared/browser/site-settings/browser-site-permission'
import {
  getBrowserSitePermissionDecision,
  setBrowserSitePermissionDecisions
} from './browser-site-permission-store'

export type BrowserSitePermissionMemory = {
  get(
    origin: string,
    permission: BrowserSitePermissionKey
  ): BrowserSitePermissionDecision | undefined
  set(
    origin: string,
    permissions: readonly BrowserSitePermissionKey[],
    decision: BrowserSitePermissionDecision
  ): void
}

export function savedBrowserSitePermissions(profileId: string): BrowserSitePermissionMemory {
  return {
    get: (origin, permission) => getBrowserSitePermissionDecision(profileId, origin, permission),
    set: (origin, permissions, decision) =>
      setBrowserSitePermissionDecisions(profileId, origin, permissions, decision)
  }
}

const sessionMemories = new Map<string, BrowserSitePermissionMemory>()

// Partition-scoped answers survive page closure until quit without entering local profile settings.
export function sessionBrowserSitePermissions(partition: string): BrowserSitePermissionMemory {
  const existing = sessionMemories.get(partition)
  if (existing) {
    return existing
  }
  const decisions = new Map<string, BrowserSitePermissionDecision>()
  const memory: BrowserSitePermissionMemory = {
    get: (origin, permission) => decisions.get(`${origin} ${permission}`),
    set: (origin, permissions, decision) => {
      for (const permission of permissions) {
        decisions.set(`${origin} ${permission}`, decision)
      }
    }
  }
  sessionMemories.set(partition, memory)
  return memory
}

const memoryBySession = new WeakMap<Session, BrowserSitePermissionMemory>()

/** Lets prompts outside the permission handler, like opening apps, use the session's answers. */
export function registerBrowserSessionSitePermissions(
  sess: Session,
  memory: BrowserSitePermissionMemory | null
): void {
  if (memory) {
    memoryBySession.set(sess, memory)
  } else {
    memoryBySession.delete(sess)
  }
}

/** Null for sessions that never ask sites, such as previews that deny every permission. */
export function browserSessionSitePermissions(sess: Session): BrowserSitePermissionMemory | null {
  return memoryBySession.get(sess) ?? null
}
