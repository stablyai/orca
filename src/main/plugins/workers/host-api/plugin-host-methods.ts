import { ZodError } from 'zod'
import { getBoundPluginHostMethod, type PluginHostServices } from './plugin-host-method-bindings'
import { isQualifiedPluginKey } from '../../../../shared/plugins/manifest/plugin-manifest'
import {
  gatePluginHostCall as decidePluginHostCall,
  missingPluginParamCapability
} from '../../../../shared/plugins/capabilities/plugin-capability-gate'
import type { PluginCapabilityKind } from '../../../../shared/plugins/capabilities/plugin-capabilities'
import { isPluginJsonObject } from '../../../../shared/plugins/manifest/plugin-json-object'
import type {
  PluginHostCallOutcome,
  PluginSurface
} from '../../../../shared/plugins/frames/plugin-protocol'
import type { PluginAuditLog } from '../../plugin-audit-log'
import {
  PLUGIN_RUNTIME_FAILURE_CODES_SINCE,
  PluginHostCallError,
  PluginRuntimeCallError,
  UNSCOPED_PLUGIN_HOST_CALL,
  type PluginHostCallScope
} from './plugin-host-call-scope'

/**
 * Host API 1 handler bindings — the one place plugin-originated calls
 * (panel bridge, worker hostCall, serve RPC relay) execute. Handlers
 * delegate to runtime services through the structural `PluginHostServices`
 * interface, so this module stays electron-free and the relay conformance
 * suite can run the identical chokepoint against a fake service set.
 */

export type ExecutePluginHostCallInput = {
  /** Qualified plugin key, bound host-side from authenticated identity. */
  pluginId: string
  method: string
  params: unknown
  surface: PluginSurface
  /** Consented capability kinds; null = unknown/disabled/consent-stale. */
  grantedCapabilities: readonly PluginCapabilityKind[] | null
  /** A development plugin, which may call proposed methods. */
  allowProposed?: boolean
  services: PluginHostServices | null
  audit?: Pick<PluginAuditLog, 'record'>
  /** Re-checked right before the side effect; absent only in tests and the relay suite. */
  scope?: PluginHostCallScope
}

export async function executePluginHostCall(
  input: ExecutePluginHostCallInput
): Promise<PluginHostCallOutcome> {
  if (!isQualifiedPluginKey(input.pluginId)) {
    return { ok: false, code: 'invalid_request', error: 'invalid qualified plugin key' }
  }
  const gate = decidePluginHostCall(
    {
      grantedCapabilities: input.grantedCapabilities,
      surface: input.surface,
      allowProposed: input.allowProposed
    },
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
  const missing = missingPluginParamCapability(
    bound.spec,
    prepared.params,
    input.grantedCapabilities ?? []
  )
  if (missing) {
    return {
      ok: false,
      code: 'capability_denied',
      error: `${missing.param} needs the "${missing.capability}" capability`
    }
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
  const scope = input.scope ?? UNSCOPED_PLUGIN_HOST_CALL
  try {
    // The audit write awaited: approval may have been revoked meanwhile.
    scope.assertActive()
    const validated = await prepared.execute({
      pluginId: input.pluginId,
      surface: input.surface,
      services,
      scope
    })
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
    if (error instanceof ZodError) {
      // A runtime answer Orca's own binding did not expect; its shape is internal.
      scope.log?.(`${input.method}: unexpected runtime answer: ${error.message}`)
      return {
        ok: false,
        code: 'action_failed',
        error: `internal: malformed ${input.method} answer`
      }
    }
    if (error instanceof PluginHostCallError) {
      if (error.detail) {
        scope.log?.(`${input.method}: ${error.detail}`)
      }
      const { message, retryAfterMs } = error
      const code =
        error instanceof PluginRuntimeCallError &&
        bound.spec.since < PLUGIN_RUNTIME_FAILURE_CODES_SINCE
          ? 'action_failed'
          : error.code
      return {
        ok: false,
        code,
        error: message,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs })
      }
    }
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
    case 'terminal.focus':
    case 'terminal.close':
      return `terminal=${String(record.terminalId)}`
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
