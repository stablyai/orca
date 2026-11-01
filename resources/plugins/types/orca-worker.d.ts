// Author typings for the `orca` object a `trusted-worker` plugin's `activate(orca)` receives.
// Type-only: `import type { OrcaWorkerApi } from 'orca/worker'`; there is no runtime module.
// Mirrors src/main/plugins/workers/plugin-host-runtime.ts (checked by plugin-worker-typings.test.ts).

declare module 'orca/worker' {
  import type {
    Disposable,
    HostApi,
    HostApiVersion,
    PluginEventName,
    PluginEvents
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
    /** Consented capability kinds; informational, the host re-checks every call. */
    readonly grantedCapabilities: readonly string[]
    /** Lands in `orca plugin logs`. */
    log(message: string): void
  }
  /** The default export of a worker's `main` module; `deactivate` may be exported beside it. */
  export type Activate = (orca: OrcaWorkerApi) => void | Promise<void>
}
