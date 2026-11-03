import type { z } from 'zod'
import type { PluginHostMethodSpec } from '../../../shared/plugins/workers/plugin-host-api'
import type { PluginHostCallScope } from './plugin-host-call-scope'
import type { PluginHostServices } from './plugin-host-method-bindings'

export type PluginHostMethodContext = {
  pluginId: string
  services: PluginHostServices
  scope: PluginHostCallScope
}

export type PreparedPluginHostCall =
  | { ok: false; issue: string }
  | {
      ok: true
      params: unknown
      /** Runs the handler; `value` is null when the result failed its schema. */
      execute: (ctx: PluginHostMethodContext) => Promise<{ value: unknown } | null>
    }

export type BoundPluginHostMethod = {
  spec: PluginHostMethodSpec
  prepare: (params: unknown) => PreparedPluginHostCall
}

export function bind<P extends z.ZodType, R extends z.ZodType>(
  spec: PluginHostMethodSpec<P, R>,
  handler: (params: z.output<P>, ctx: PluginHostMethodContext) => Promise<z.input<R>>
): BoundPluginHostMethod {
  return {
    spec,
    prepare(raw) {
      const parsed = spec.params.safeParse(raw)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        const path = issue?.path.join('.') || '(root)'
        return { ok: false, issue: `${path}: ${issue?.message ?? 'invalid params'}` }
      }
      return {
        ok: true,
        params: parsed.data,
        async execute(ctx) {
          const result = spec.result.safeParse(await handler(parsed.data, ctx))
          return result.success ? { value: result.data } : null
        }
      }
    }
  }
}
