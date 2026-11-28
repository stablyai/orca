// A confirmed detached HEAD cannot be renamed; without a pause every `working` event re-probes Git.
export const FIRST_WORK_DETACHED_HEAD_COOLDOWN_MS = 30_000
export const FIRST_WORK_DETACHED_HEAD_COOLDOWN_LIMIT = 512

type DetachedHeadCooldown = { incarnation: string; retryAt: number }

const cooldownsByWorkspace = new Map<string, DetachedHeadCooldown>()

export function resetFirstWorkDetachedHeadCooldowns(): void {
  cooldownsByWorkspace.clear()
}

/** Another incarnation's or an expired pause is dropped, so it never gates a recreated workspace. */
export function isFirstWorkDetachedHeadCoolingDown(
  workspaceId: string,
  incarnation: string,
  now = Date.now()
): boolean {
  const cooldown = cooldownsByWorkspace.get(workspaceId)
  if (!cooldown) {
    return false
  }
  if (cooldown.incarnation !== incarnation || now >= cooldown.retryAt) {
    cooldownsByWorkspace.delete(workspaceId)
    return false
  }
  return true
}

/** Starts at confirmed completion so a slow probe cannot leave a shortened window. */
export function armFirstWorkDetachedHeadCooldown(
  workspaceId: string,
  incarnation: string,
  now = Date.now()
): void {
  cooldownsByWorkspace.delete(workspaceId)
  cooldownsByWorkspace.set(workspaceId, {
    incarnation,
    retryAt: now + FIRST_WORK_DETACHED_HEAD_COOLDOWN_MS
  })
  // Evicting only permits an early probe.
  while (cooldownsByWorkspace.size > FIRST_WORK_DETACHED_HEAD_COOLDOWN_LIMIT) {
    const oldest = cooldownsByWorkspace.keys().next().value
    if (typeof oldest !== 'string') {
      return
    }
    cooldownsByWorkspace.delete(oldest)
  }
}

export function clearFirstWorkDetachedHeadCooldown(workspaceId: string): void {
  cooldownsByWorkspace.delete(workspaceId)
}
