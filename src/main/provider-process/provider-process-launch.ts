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
  if (platform === 'win32') {
    // Windows env names fold case: Node passes whichever PATH spelling sorts first, so an overlay's
    // Path must replace the inherited PATH instead of sitting beside it (#32127).
    const overlayPathKey = Object.keys(launch.env ?? {}).find(
      (key) => key.toLowerCase() === 'path' && launch.env?.[key] !== undefined
    )
    if (overlayPathKey) {
      for (const key of Object.keys(childEnv)) {
        if (key !== overlayPathKey && key.toLowerCase() === 'path') {
          delete childEnv[key]
        }
      }
    }
  }
  for (const key of launch.envToDelete ?? []) {
    delete childEnv[key]
  }
  return childEnv
}
