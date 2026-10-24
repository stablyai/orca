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

/** The one env rule for provider children: inherit, overlay, then strip (so a delete beats an overlay). */
export function resolveProviderChildEnv(
  launch: Pick<ProviderProcessLaunch, 'env' | 'envToDelete'>,
  baseEnv: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...baseEnv, ...launch.env }
  for (const key of launch.envToDelete ?? []) {
    delete childEnv[key]
  }
  return childEnv
}

/** Direct provider streams belong to the execution host, never another runtime. */
export function createProviderSpawnSpec(
  launch: ProviderProcessLaunch,
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): {
  program: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  detached: boolean
} {
  const env = resolveProviderChildEnv(launch, baseEnv)
  if (platform !== 'win32') {
    delete env.ELECTRON_RUN_AS_NODE
  }
  return {
    program: launch.command,
    args: launch.args,
    env,
    cwd: launch.cwd ?? process.cwd(),
    detached: platform !== 'win32'
  }
}
