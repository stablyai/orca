import {
  PANEL_MESSAGE_MAX_BYTES,
  PANEL_WORKER_REPLY_MAX_BYTES
} from '../../../shared/plugins/frames/plugin-frame-bridge'
import { structuredCloneMessageBytes } from '../../../shared/plugins/frames/plugin-panel-message-budget'
import type { PluginHostCallOutcome } from '../../../shared/plugins/frames/plugin-protocol'
import { pluginExecutionProfile } from '../../../shared/plugins/contributions/plugin-execution-profile'
import { PLUGIN_WORKER_INVOKE_TIMEOUT_MS } from '../../../shared/plugins/workers/plugin-host-protocol'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import type { PluginWorkerHandle } from '../workers/plugin-host-process'

type JsonRead = { ok: true; value: unknown } | { ok: false; reason: 'not_json' | 'too_large' }

/** JSON round trip, so the worker and the panel only ever see plain JSON of bounded size. */
function readJson(value: unknown, maxBytes: number): JsonRead {
  // Why first: it is cycle-safe and stops at the cap, so a huge reply is never stringified.
  if (structuredCloneMessageBytes(value, maxBytes) > maxBytes) {
    return { ok: false, reason: 'too_large' }
  }
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch {
    return { ok: false, reason: 'not_json' }
  }
  if (text === undefined) {
    return { ok: false, reason: 'not_json' }
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return { ok: false, reason: 'too_large' }
  }
  return { ok: true, value: JSON.parse(text) }
}

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    task.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

/** Routes one panel's JSON to the worker of the plugin that owns the panel and returns its reply.
 *  The caller binds `plugin` and `panelId` from the panel session; the frame names neither. */
export async function deliverPluginPanelMessage(input: {
  plugin: ValidDiscoveredPlugin
  panelId: string
  message: unknown
  ensureWorker: (plugin: ValidDiscoveredPlugin) => Promise<PluginWorkerHandle>
  log: (line: string) => void
}): Promise<PluginHostCallOutcome> {
  const { plugin, panelId } = input
  if (pluginExecutionProfile(plugin.manifest) !== 'trusted-worker' || !plugin.manifest.main) {
    return {
      ok: false,
      code: 'unknown_method',
      error: 'this plugin has no worker to receive panel messages'
    }
  }
  const request = readJson(input.message, PANEL_MESSAGE_MAX_BYTES)
  if (!request.ok) {
    return request.reason === 'too_large'
      ? { ok: false, code: 'too_large', error: 'panel message exceeds the size limit' }
      : { ok: false, code: 'invalid_params', error: 'panel message must be JSON' }
  }
  let handle: PluginWorkerHandle
  try {
    // Why bounded: ensure() can wait for a worker slot, and the panel must not hang behind it.
    handle = await withTimeout(input.ensureWorker(plugin), PLUGIN_WORKER_INVOKE_TIMEOUT_MS)
  } catch {
    // Why no log: the worker controller already records why activation failed.
    return { ok: false, code: 'unavailable', error: 'plugin worker is not available' }
  }
  const outcome = await handle.deliverPanelMessage(panelId, request.value)
  if (!outcome.ok) {
    return outcome
  }
  const reply = readJson(outcome.value, PANEL_WORKER_REPLY_MAX_BYTES)
  if (reply.ok) {
    return { ok: true, value: reply.value }
  }
  input.log(`panel ${panelId} reply dropped: ${reply.reason}`)
  return reply.reason === 'too_large'
    ? {
        ok: false,
        code: 'too_large',
        error: `worker reply exceeds the ${PANEL_WORKER_REPLY_MAX_BYTES} byte limit`
      }
    : { ok: false, code: 'action_failed', error: 'worker reply must be JSON' }
}
