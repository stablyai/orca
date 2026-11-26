export type ProviderProcessLaunch = {
  command: string
  args: string[]
  /** Workspace directory used by the provider process itself. */
  cwd?: string
  /** Overlay on the inherited environment. */
  env?: Record<string, string>
  /** Keys stripped after the overlay. */
  envToDelete?: readonly string[]
}

export function resolveProviderChildEnv(
  launch: Pick<ProviderProcessLaunch, 'env' | 'envToDelete'>,
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...baseEnv, ...launch.env }
  // Windows names are case-insensitive: a differently cased inherited key is the same variable.
  const named = (key: string): string => (platform === 'win32' ? key.toUpperCase() : key)
  const deleted = new Set((launch.envToDelete ?? []).map(named))
  for (const key of Object.keys(childEnv)) {
    if (deleted.has(named(key))) {
      delete childEnv[key]
    }
  }
  return childEnv
}
