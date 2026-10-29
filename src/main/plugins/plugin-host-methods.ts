import { getBoundPluginHostMethod, type PluginHostServices } from './plugin-host-method-bindings'
import { isQualifiedPluginKey } from '../../shared/plugins/plugin-manifest'
import { gatePluginHostCall as decidePluginHostCall } from '../../shared/plugins/plugin-capability-gate'
import type { PluginCapabilityKind } from '../../shared/plugins/plugin-capabilities'
import type { PluginPanelActionOutcome } from '../../shared/plugins/plugin-panel-bridge'
import type { PluginAuditLog } from './plugin-audit-log'

// All plugin transports share these Electron-free host-policy checks and runtime bindings.

export type { PluginHostServices } from './plugin-host-method-bindings'

export type ExecutePluginHostCallInput = {
  /** Qualified plugin key, bound host-side from authenticated identity. */
  pluginId: string
  method: string
  params: unknown
  viaPanel: boolean
  /** Consented capability kinds; null = unknown/disabled/consent-stale. */
  grantedCapabilities: readonly PluginCapabilityKind[] | null
  services: PluginHostServices | null
  audit?: Pick<PluginAuditLog, 'record'>
}

export async function executePluginHostCall(
  input: ExecutePluginHostCallInput
): Promise<PluginPanelActionOutcome> {
  if (!isQualifiedPluginKey(input.pluginId)) {
    return { ok: false, code: 'invalid_request', error: 'invalid qualified plugin key' }
  }
  const gate = decidePluginHostCall(
    { grantedCapabilities: input.grantedCapabilities, viaPanel: input.viaPanel },
    input.method
  )
  if (!gate.granted) {
    return { ok: false, code: gate.code, error: gate.error }
  }
  const bound = getBoundPluginHostMethod(input.method)
  if (!bound) {
    return { ok: false, code: 'unknown_method', error: `unknown host method: ${input.method}` }
  }
  const parsedParams = bound.spec.params.safeParse(input.params)
  if (!parsedParams.success) {
    const issue = parsedParams.error.issues[0]
    const path = issue?.path.join('.') || '(root)'
    return {
      ok: false,
      code: 'invalid_params',
      error: `${path}: ${issue?.message ?? 'invalid params'}`
    }
  }
  if (!input.services) {
    return { ok: false, code: 'unavailable', error: 'runtime is not available' }
  }
  const auditMutation = async (outcome: 'attempt' | 'ok' | 'error'): Promise<void> => {
    if (bound.spec.mutation && input.audit) {
      await input.audit.record({
        ts: Date.now(),
        actor: `plugin:${input.pluginId}`,
        method: input.method,
        summary: summarizeParams(input.method, parsedParams.data),
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
    const value = await bound.handler(parsedParams.data, {
      pluginId: input.pluginId,
      services: input.services
    })
    const validated = bound.spec.result.safeParse(value)
    if (!validated.success) {
      await auditMutation('error').catch(() => undefined)
      // Malformed host results must not leak unvalidated shapes through any plugin transport.
      return {
        ok: false,
        code: 'action_failed',
        error: `internal: malformed ${input.method} result`
      }
    }
    await auditMutation('ok').catch(() => undefined)
    return { ok: true, value: validated.data }
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
  const record = (typeof params === 'object' && params !== null ? params : {}) as Record<
    string,
    unknown
  >
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
