// Author typings for the `orca` object a `trusted-worker` plugin's `activate(orca)` receives.
// Type-only: `import type { OrcaWorkerApi } from 'orca/worker'`; there is no runtime module.
// Mirrors src/main/plugins/workers/plugin-host-runtime.ts (checked by plugin-worker-typings.test.ts).

declare module 'orca/worker' {
  import type {
    Disposable,
    HostApi,
    HostApiVersion,
    JsonValue,
    PluginEventName,
    PluginEvents,
    PluginPanelEvents,
    PluginRequestInput,
    PluginRequestOutput,
    PluginRequests,
    SecretsApi,
    SettingsApi,
    StorageApi,
    Undeclared
  } from 'orca/host'

  export type {
    Disposable,
    HostCallError,
    HostErrorCode,
    JsonValue,
    PluginEventName,
    PluginEvents
  } from 'orca/host'

  /** `signal` aborts when Orca stops waiting for the command. */
  export type CommandContext = { signal: AbortSignal }
  /** The open panel or editor that asked; `id` stays the same while it stays open. */
  export type PanelCaller = { id: string; surface: 'panel' | 'editor'; contributionId: string }
  /** `signal` aborts when the request times out or its panel closes. */
  export type PanelRequestContext = { panel: PanelCaller; signal: AbortSignal }
  export type PanelsApi = {
    /** Answers a panel's `plugin.request(name, input)` with a JSON value. A thrown error whose
     *  `code` is a host error code (`invalid_params`, `conflict`, ...) reaches the panel with it;
     *  any other is `action_failed`. */
    handle<K extends keyof PluginRequests>(
      name: K,
      handler: (
        input: PluginRequestInput<K>,
        context: PanelRequestContext
      ) => PluginRequestOutput<K> | Promise<PluginRequestOutput<K>>
    ): Disposable
    handle<N extends string>(
      name: Undeclared<N, PluginRequests>,
      handler: (input: JsonValue | undefined, context: PanelRequestContext) => unknown
    ): Disposable
    /** To every open panel of this plugin, or one (`panel` from a request's context). Fire and
     *  forget: at most 256 KiB, 200 per 10 s. */
    post<K extends keyof PluginPanelEvents>(
      event: K,
      payload: PluginPanelEvents[K],
      options?: { panel?: string }
    ): void
    post<N extends string>(
      event: Undeclared<N, PluginPanelEvents>,
      payload?: JsonValue,
      options?: { panel?: string }
    ): void
  }
  export type OrcaWorkerApi = {
    readonly api: HostApiVersion
    readonly commands: {
      /** A string result is shown as-is in Orca; anything else as JSON. */
      register(
        commandId: string,
        handler: (args: unknown, context: CommandContext) => unknown
      ): Disposable
    }
    readonly events: {
      /** Only events listed in the manifest's `contributes.events` arrive. */
      on<E extends PluginEventName>(
        event: E,
        handler: (payload: PluginEvents[E]) => void | Promise<void>
      ): Disposable
    }
    readonly host: HostApi<'worker'>
    /** This plugin's panels and custom editors. */
    readonly panels: PanelsApi
    /** Same store as panels' `storage` (`storage:own`); `onDidChange` hears their writes too. */
    readonly storage: StorageApi
    /** `settings:own`; `onDidChange` also hears the person changing them in Settings. */
    readonly settings: SettingsApi
    /** `secrets:own`. */
    readonly secrets: SecretsApi
    /** Consented capability kinds; informational, the host re-checks every call. */
    readonly grantedCapabilities: readonly string[]
    /** Lands in `orca plugin logs`. */
    log(message: string): void
  }
  /** A worker's `main` must export it as the DEFAULT export (`export default function
   *  activate(orca)`); Orca calls it once when the worker starts and never calls a named
   *  `activate`. An optional `export function deactivate()` is awaited before it stops. */
  export type Activate = (orca: OrcaWorkerApi) => void | Promise<void>
}
