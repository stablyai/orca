import type { z } from 'zod'
import type { PluginHookName } from '../../../shared/plugins/contributions/plugin-hook-contribution'
import type { PluginHookChainOutcome } from '../../../shared/plugins/workers/plugin-hook-chain'

/**
 * Where Orca's own code meets plugin hooks. Hooks run in the plugin workers of the Orca process
 * handling the request, before it acts: an SSH or WSL terminal or workspace is decided on the
 * desktop before the work is sent to its host; a paired client's request is decided by the server
 * it reaches.
 */
export type PluginHookRunner = {
  /** Synchronous so the common case (no plugin lists the hook) adds no await. */
  wants(event: PluginHookName): boolean
  run(event: PluginHookName, payload: unknown): Promise<PluginHookChainOutcome>
}

let runner: PluginHookRunner | null = null

export function setPluginHookRunner(next: PluginHookRunner | null): void {
  runner = next
}

export function pluginHookWanted(event: PluginHookName): boolean {
  return runner?.wants(event) === true
}

/** A plugin hook refused the action; the message names the plugin and its reason. */
export class PluginHookDeniedError extends Error {
  constructor(
    readonly event: PluginHookName,
    readonly pluginKey: string,
    readonly reason: string
  ) {
    super(`${event} denied by plugin ${pluginKey}: ${reason}`)
    this.name = 'PluginHookDeniedError'
  }
}

/** The payload Orca should act on; throws {@link PluginHookDeniedError} when a plugin refuses. */
export async function runPluginHook<S extends z.ZodType>(
  event: PluginHookName,
  schema: S,
  payload: z.output<S>
): Promise<z.output<S>> {
  if (!runner?.wants(event)) {
    return payload
  }
  const outcome = await runner.run(event, payload)
  if (outcome.kind === 'deny') {
    throw new PluginHookDeniedError(event, outcome.pluginKey, outcome.reason)
  }
  // Why reparse: the chain validated each change, but the call site needs its own type back.
  const parsed = schema.safeParse(outcome.payload)
  return parsed.success ? parsed.data : payload
}

/** Observe-only hooks: Orca never waits on them. */
export function notifyPluginHook(event: PluginHookName, payload: unknown): void {
  if (runner?.wants(event)) {
    void runner.run(event, payload).catch(() => undefined)
  }
}
