import { PluginCliError } from '../../../shared/plugins/approval/plugin-cli-approval'
import {
  isPluginHookName,
  PLUGIN_HOOK_NAMES,
  type PluginHookName
} from '../../../shared/plugins/contributions/plugin-hook-contribution'
import { PLUGIN_HOOK_SPECS } from '../../../shared/plugins/events/plugin-hook-payloads'
import { PLUGIN_WORKER_READY_TIMEOUT_MS } from '../../../shared/plugins/workers/plugin-host-protocol'
import { runPluginHookChain } from '../../../shared/plugins/workers/plugin-hook-chain'
import { isInvalidDiscoveredPlugin } from '../plugin-discovery'
import { assertPluginSystemEnabled, resolveDevPlugin } from '../plugin-dev-event-emit'
import type { PluginDevFolderLookup, PluginDevFolderTarget } from '../plugin-dev-folders'
import type { PluginEventDeliveryContext } from '../plugin-event-delivery'
import type { PluginWorkerHandle } from '../workers/plugin-host-process'

export type PluginDevHookService = PluginDevFolderLookup & {
  options: { isPluginSystemEnabled: () => boolean }
  eventDelivery: PluginEventDeliveryContext
}

export type PluginDevHookResult = {
  pluginKey: string
  event: PluginHookName
  decision: { kind: 'continue'; event: unknown } | { kind: 'deny'; reason: string }
}

function refuse(message: string, nextSteps: string[]): PluginCliError {
  return new PluginCliError('invalid_argument', message, { nextSteps })
}

/** `orca plugin dev hook`: one hook through the real chain, with one development plugin in it. */
export async function firePluginDevHook(input: {
  service: PluginDevHookService
  target: PluginDevFolderTarget
  event: string
  payload: unknown
}): Promise<PluginDevHookResult> {
  const { service, event } = input
  assertPluginSystemEnabled(service)
  if (!isPluginHookName(event)) {
    throw refuse(`${event} is not an Orca plugin hook.`, [
      `Pass one of: ${PLUGIN_HOOK_NAMES.join(', ')}.`
    ])
  }
  const plugin = await resolveDevPlugin(
    service,
    input.target,
    'dev hook only runs hooks through development plugins'
  )
  if (isInvalidDiscoveredPlugin(plugin) || !service.eventDelivery.isRuntimeApproved(plugin)) {
    throw refuse(`${plugin.pluginKey} is not a valid, approved and enabled plugin.`, [
      'Run `orca plugin dev load <dir>` and approve it with `--approve`.'
    ])
  }
  if (!plugin.manifest.main || !plugin.manifest.contributes.hooks.some((h) => h.event === event)) {
    throw refuse(`${plugin.pluginKey} does not list ${event}.`, [
      `Add { "event": "${event}" } to contributes.hooks (with \`main\`), then reload.`
    ])
  }
  const parsed = PLUGIN_HOOK_SPECS[event].payload.safeParse(input.payload ?? {})
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(event)'}: ${issue.message}`
    )
    throw refuse(`--data is not a valid ${event} event.`, [
      ...issues,
      'The host API reference lists every hook event.'
    ])
  }
  let worker: PluginWorkerHandle | null = null
  const outcome = await runPluginHookChain({
    event,
    payload: parsed.data,
    participants: [plugin.pluginKey],
    start: async () => {
      worker = await service.eventDelivery.ensureWorker(plugin)
    },
    startTimeoutMs: PLUGIN_WORKER_READY_TIMEOUT_MS,
    invoke: (_key, current, timeoutMs) =>
      worker ? worker.runHook(event, current, timeoutMs) : Promise.reject(new Error('no worker')),
    log: (pluginKey, line) => service.eventDelivery.logWarning(pluginKey)(line),
    now: () => performance.now()
  })
  return {
    pluginKey: plugin.pluginKey,
    event,
    decision:
      outcome.kind === 'deny'
        ? { kind: 'deny', reason: outcome.reason }
        : { kind: 'continue', event: outcome.payload }
  }
}
