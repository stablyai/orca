export type HostWorkspaceSshTarget = { id: string; label: string }

/** Inputs the workspace list needs to name and badge rows from non-local execution hosts. */
export type HostWorkspaceHostContext = {
  sshTargets: readonly HostWorkspaceSshTarget[]
  hostSettingOverrides: unknown
  platform: NodeJS.Platform | null
}

export function readHostWorkspaceSshTargets(result: unknown): HostWorkspaceSshTarget[] {
  const targets = (result as { targets?: unknown } | null)?.targets
  if (!Array.isArray(targets)) {
    return []
  }
  return targets.filter(
    (target): target is HostWorkspaceSshTarget =>
      typeof target === 'object' &&
      target !== null &&
      typeof (target as HostWorkspaceSshTarget).id === 'string' &&
      typeof (target as HostWorkspaceSshTarget).label === 'string'
  )
}

export function readHostWorkspacePlatform(result: unknown): NodeJS.Platform | null {
  const platform = (result as { platform?: unknown } | null)?.platform
  return typeof platform === 'string' && platform ? (platform as NodeJS.Platform) : null
}

export function readHostWorkspaceSettingOverrides(result: unknown): unknown {
  return (result as { settings?: { hostSettingOverrides?: unknown } } | null)?.settings
    ?.hostSettingOverrides
}
