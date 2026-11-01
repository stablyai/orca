// Author typings for the `orca` object a `trusted-worker` plugin's `activate(orca)` receives.
// Type-only: `import type { OrcaWorkerApi } from 'orca/worker'`; there is no runtime module.
// Mirrors src/main/plugins/workers/plugin-host-runtime.ts (checked by plugin-worker-typings.test.ts).

declare module 'orca/worker' {
  import type {
    Disposable,
    HostApi,
    HostApiVersion,
    PluginEventName,
    PluginEvents,
    PluginPanelEventName,
    PluginPanelEventPayload,
    PluginRequestInput,
    PluginRequestName,
    PluginRequestOutput,
    SecretsApi,
    SettingsApi,
    StorageApi
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
    handle<K extends PluginRequestName>(
      name: K,
      handler: (
        input: PluginRequestInput<K>,
        context: PanelRequestContext
      ) => PluginRequestOutput<K> | Promise<PluginRequestOutput<K>>
    ): Disposable
    /** To every open panel of this plugin, or one (`panel` from a request's context). Fire and
     *  forget: at most 256 KiB, 200 per 10 s. */
    post<K extends PluginPanelEventName>(
      event: K,
      payload: PluginPanelEventPayload<K>,
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
  /** The default export of a worker's `main` module; `deactivate` may be exported beside it. */
  export type Activate = (orca: OrcaWorkerApi) => void | Promise<void>
}
