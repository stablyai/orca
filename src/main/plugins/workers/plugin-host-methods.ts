import { getBoundPluginHostMethod, type PluginHostServices } from './plugin-host-method-bindings'
import { isQualifiedPluginKey } from '../../../shared/plugins/manifest/plugin-manifest'
import { gatePluginHostCall as decidePluginHostCall } from '../../../shared/plugins/capabilities/plugin-capability-gate'
import type { PluginCapabilityKind } from '../../../shared/plugins/capabilities/plugin-capabilities'
import { isPluginJsonObject } from '../../../shared/plugins/manifest/plugin-json-object'
import type {
  PluginHostCallOutcome,
  PluginSurface
} from '../../../shared/plugins/frames/plugin-protocol'
import type { PluginAuditLog } from '../plugin-audit-log'

/**
 * Host API 1 handler bindings — the one place plugin-originated calls
 * (panel bridge, worker hostCall, serve RPC relay) execute. Handlers
 * delegate to runtime services through the structural `PluginHostServices`
 * interface, so this module stays electron-free and the relay conformance
 * suite can run the identical chokepoint against a fake service set.
 */

export type { PluginHostServices } from './plugin-host-method-bindings'

export type ExecutePluginHostCallInput = {
  /** Qualified plugin key, bound host-side from authenticated identity. */
  pluginId: string
  method: string
  params: unknown
  surface: PluginSurface
  /** Consented capability kinds; null = unknown/disabled/consent-stale. */
  grantedCapabilities: readonly PluginCapabilityKind[] | null
  services: PluginHostServices | null
  audit?: Pick<PluginAuditLog, 'record'>
}

export async function executePluginHostCall(
  input: ExecutePluginHostCallInput
): Promise<PluginHostCallOutcome> {
  if (!isQualifiedPluginKey(input.pluginId)) {
    return { ok: false, code: 'invalid_request', error: 'invalid qualified plugin key' }
  }
  const gate = decidePluginHostCall(
    { grantedCapabilities: input.grantedCapabilities, surface: input.surface },
    input.method
  )
  if (!gate.granted) {
    return { ok: false, code: gate.code, error: gate.error }
  }
  const bound = getBoundPluginHostMethod(input.method)
  if (!bound) {
    return { ok: false, code: 'unknown_method', error: `unknown host method: ${input.method}` }
  }
  const prepared = bound.prepare(input.params)
  if (!prepared.ok) {
    return { ok: false, code: 'invalid_params', error: prepared.issue }
  }
  const services = input.services
  if (!services) {
    return { ok: false, code: 'unavailable', error: 'runtime is not available' }
  }
  const auditMutation = async (outcome: 'attempt' | 'ok' | 'error'): Promise<void> => {
    if (bound.spec.mutation && input.audit) {
      await input.audit.record({
        ts: Date.now(),
        actor: `plugin:${input.pluginId}`,
        method: input.method,
        summary: summarizeParams(input.method, prepared.params),
        outcome
      })
    }
  }
  if (bound.spec.mutation) {
    if (!input.audit) {
      return {
        ok: false,
        code: 'unavailable',
        error: 'mutation audit log is not available'
      }
    }
    try {
      // Failed intent logging must prevent mutation.
      await auditMutation('attempt')
    } catch {
      return {
        ok: false,
        code: 'action_failed',
        error: 'mutation audit log could not be written'
      }
    }
  }
  try {
    const validated = await prepared.execute({ pluginId: input.pluginId, services })
    if (!validated) {
      await auditMutation('error').catch(() => undefined)
      // Malformed host results must not leak unvalidated shapes through any plugin transport.
      return {
        ok: false,
        code: 'action_failed',
        error: `internal: malformed ${input.method} result`
      }
    }
    await auditMutation('ok').catch(() => undefined)
    return { ok: true, value: validated.value }
  } catch (error) {
    await auditMutation('error').catch(() => undefined)
    return {
      ok: false,
      code: 'action_failed',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function summarizeParams(method: string, params: unknown): string {
  const record = isPluginJsonObject(params) ? params : {}
  switch (method) {
    case 'terminal.sendText': {
      const text = typeof record.text === 'string' ? record.text : ''
      return `terminal=${String(record.terminalId)} bytes=${Buffer.byteLength(text, 'utf8')} enter=${record.enter === true}`
    }
    case 'notifications.show': {
      const title = typeof record.title === 'string' ? record.title : ''
      return `titleChars=${title.length}`
    }
    case 'storage.set':
    case 'storage.delete':
    case 'secrets.set':
    case 'secrets.delete':
    case 'settings.set':
      return `key=${String(record.key)}`
    default:
      return ''
  }
}
