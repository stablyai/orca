import type { z } from 'zod'
import {
  isPluginHostMethodName,
  PLUGIN_HOST_API,
  PLUGIN_HOST_METHOD_NAMES,
  PLUGIN_TERMINAL_ID_MAX_LENGTH,
  PLUGIN_WORKSPACE_LABEL_MAX_LENGTH,
  PLUGIN_WORKSPACE_TERMINAL_LIMIT,
  type PluginHostMethodName,
  type PluginHostMethodSpec,
  type PluginJsonValue
} from '../../../shared/plugins/workers/plugin-host-api'
import { shortPluginBranchName } from '../../../shared/plugins/events/plugin-events'

export type PluginWorktreeContext = {
  worktreeId: string
  branch: string
  displayName: string
}

export type PluginHostServices = {
  resolveActiveWorktreeContext(): Promise<PluginWorktreeContext | null>
  listWorktreeTerminals(worktreeId: string): Promise<{ id: string }[]>
  sendTerminalText(
    terminalId: string,
    action: { text: string; enter: boolean }
  ): Promise<{ accepted: boolean }>
  dispatchPluginNotification(input: {
    pluginId: string
    title: string
    body?: string
  }): Promise<{ delivered: boolean }>
  storage: {
    get(pluginId: string, key: string): PluginJsonValue | undefined
    set(
      pluginId: string,
      key: string,
      value: PluginJsonValue
    ): { ok: true } | { ok: false; error: string }
    delete(pluginId: string, key: string): void
    keys(pluginId: string): string[]
  }
  secrets: {
    get(
      pluginId: string,
      key: string
    ): { ok: true; value: string | null } | { ok: false; error: string }
    set(pluginId: string, key: string, value: string): { ok: true } | { ok: false; error: string }
    delete(pluginId: string, key: string): void
  }
  settings: {
    getAll(pluginId: string): Record<string, PluginJsonValue>
    set(
      pluginId: string,
      key: string,
      value: PluginJsonValue
    ): { ok: true } | { ok: false; error: string }
  }
}

type PluginHostMethodContext = { pluginId: string; services: PluginHostServices }

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

function bind<P extends z.ZodType, R extends z.ZodType>(
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

const api = PLUGIN_HOST_API
const OK = { ok: true } as const

const HANDLERS: Record<PluginHostMethodName, BoundPluginHostMethod> = {
  'workspace.readContext': bind(api['workspace.readContext'], async (_params, { services }) => {
    const context = await services.resolveActiveWorktreeContext()
    if (!context) {
      return null
    }
    const terminals = await services.listWorktreeTerminals(context.worktreeId)
    // Worktree IDs embed provider paths; explicitly project safe public fields.
    return {
      branch: shortPluginBranchName(context.branch).slice(0, PLUGIN_WORKSPACE_LABEL_MAX_LENGTH),
      displayName: context.displayName.slice(0, PLUGIN_WORKSPACE_LABEL_MAX_LENGTH),
      terminals: terminals
        .filter(
          (terminal) =>
            terminal.id.length > 0 && terminal.id.length <= PLUGIN_TERMINAL_ID_MAX_LENGTH
        )
        .slice(0, PLUGIN_WORKSPACE_TERMINAL_LIMIT)
        .map((terminal) => ({ id: terminal.id }))
    }
  }),
  'terminal.sendText': bind(api['terminal.sendText'], async (params, { services }) => {
    const context = await services.resolveActiveWorktreeContext()
    if (!context) {
      throw new Error('no active worktree is available for terminal input')
    }
    // Handles outlive focus changes; revalidate current workspace membership before terminal input.
    const terminals = await services.listWorktreeTerminals(context.worktreeId)
    if (!terminals.some((terminal) => terminal.id === params.terminalId)) {
      throw new Error('terminal is outside the active worktree')
    }
    const { text, enter } = params
    const result = await services.sendTerminalText(params.terminalId, { text, enter })
    return { accepted: result.accepted }
  }),
  'notifications.show': bind(api['notifications.show'], async (params, { pluginId, services }) =>
    services.dispatchPluginNotification({ pluginId, title: params.title, body: params.body })
  ),
  'storage.get': bind(api['storage.get'], async ({ key }, { pluginId, services }) => ({
    value: services.storage.get(pluginId, key) ?? null
  })),
  'storage.set': bind(api['storage.set'], async ({ key, value }, { pluginId, services }) =>
    okOrThrow(services.storage.set(pluginId, key, value))
  ),
  'storage.delete': bind(api['storage.delete'], async ({ key }, { pluginId, services }) => {
    services.storage.delete(pluginId, key)
    return OK
  }),
  'storage.keys': bind(api['storage.keys'], async (_params, { pluginId, services }) => ({
    keys: services.storage.keys(pluginId)
  })),
  'secrets.get': bind(api['secrets.get'], async ({ key }, { pluginId, services }) => {
    const result = services.secrets.get(pluginId, key)
    if (!result.ok) {
      throw new Error(result.error)
    }
    return { value: result.value }
  }),
  'secrets.set': bind(api['secrets.set'], async ({ key, value }, { pluginId, services }) =>
    okOrThrow(services.secrets.set(pluginId, key, value))
  ),
  'secrets.delete': bind(api['secrets.delete'], async ({ key }, { pluginId, services }) => {
    services.secrets.delete(pluginId, key)
    return OK
  }),
  'settings.get': bind(api['settings.get'], async (_params, { pluginId, services }) => ({
    settings: services.settings.getAll(pluginId)
  })),
  'settings.set': bind(api['settings.set'], async ({ key, value }, { pluginId, services }) =>
    okOrThrow(services.settings.set(pluginId, key, value))
  )
}

function okOrThrow(result: { ok: true } | { ok: false; error: string }): typeof OK {
  if (!result.ok) {
    throw new Error(result.error)
  }
  return OK
}

// Why: adding a facade schema without a binding must fail at module load,
// before a plugin can observe transport-specific behavior.
for (const name of PLUGIN_HOST_METHOD_NAMES) {
  if (HANDLERS[name].spec !== PLUGIN_HOST_API[name]) {
    throw new Error(`plugin host API binding for ${name} uses another method's spec`)
  }
}

export function getBoundPluginHostMethod(name: string): BoundPluginHostMethod | null {
  return isPluginHostMethodName(name) ? HANDLERS[name] : null
}
