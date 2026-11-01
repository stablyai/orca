import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime/types'

/** One `--shot` PNG written after a load or reload. */
export type PluginDevWatchShot = {
  panelId: string
  path: string
  width: number
  height: number
  /** False when the panel had not finished drawing by the host's timeout. */
  settled: boolean
  errors: string[]
}

/** Statuses whose panels Orca draws; an errored or invalid reload has nothing new to show. */
export const PLUGIN_DEV_WATCH_SHOOTABLE = new Set(['running', 'idle', 'restarting'])

/** A host that cannot capture now never will this session: too old, or no desktop window. */
export function isLastingShotFailure(error: unknown): boolean {
  if (error instanceof RuntimeRpcFailureError) {
    return error.response.error.message.includes('only available in the Orca desktop app')
  }
  return error instanceof RuntimeClientError && error.code === 'runtime_unsupported'
}

/** Captures each panel in turn: the right sidebar shows one panel at a time. */
export async function shootPluginPanels(
  panelIds: readonly string[],
  shoot: (panelId: string) => Promise<PluginDevWatchShot>
): Promise<PluginDevWatchShot[]> {
  const shots: PluginDevWatchShot[] = []
  for (const panelId of panelIds) {
    shots.push(await shoot(panelId))
  }
  return shots
}
