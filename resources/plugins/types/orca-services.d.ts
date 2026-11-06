// Author typings for what a plugin reaches outside its own UI: shell and files, events, the panel
// ↔ worker contract and the plugin's own storage, settings and secrets. Merges into module 'orca'
// (orca.d.ts), which components panels import; 'orca/host' re-exports the shared types for frames
// and workers. Mirrors declarative-sdk.ts, plugin-panel-shell-facades.ts and
// plugin-worker-orca-api.ts.

declare module 'orca' {
  /** Needs a press on one of the panel's controls; see "User gestures". */
  export const shell: {
    openExternal(url: string): Promise<HostMethods['shell.openExternal']['result']>
  }
  /** Needs a press on one of the panel's controls; see "User gestures". */
  export const files: {
    saveAs(
      options: HostMethods['files.saveAs']['params']
    ): Promise<HostMethods['files.saveAs']['result']>
  }
  /** Events a panel can subscribe to: the theme, and workspace and agent events (each needs the
   *  read capability of its domain: `workspace:read` or `agent:read`). */
  export type OrcaEvents = {
    theme: { colorScheme: 'light' | 'dark' }
  } & PluginEvents
  export function on<E extends keyof OrcaEvents>(
    event: E,
    handler: (payload: OrcaEvents[E]) => void
  ): Disposable
  /**
   * Your panel ↔ worker contract, declared once with declaration merging and imported by both
   * sides, so requests and their answers are typed end to end:
   *
   *     declare module 'orca' {
   *       interface PluginRequests { 'todos.list': { input: { done?: boolean }; output: Todo[] } }
   *       interface PluginPanelEvents { 'todos.changed': { count: number } }
   *     }
   */
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  export interface PluginRequests {}
  /** Events your worker sends with `orca.panels.post(event, payload)`. */
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  export interface PluginPanelEvents {}
  /** What a declared request takes; `undefined` when it declares no `input`. */
  export type PluginRequestInput<K extends keyof PluginRequests> = PluginRequests[K] extends {
    input: infer I
  }
    ? I
    : undefined
  /** What a declared request answers with; `null` when it declares no `output`. */
  export type PluginRequestOutput<K extends keyof PluginRequests> = PluginRequests[K] extends {
    output: infer O
  }
    ? O
    : null
  /** `timeoutMs` (at most 120000, default 30000) is how long the worker may take. */
  export type PluginRequestOptions = { signal?: AbortSignal; timeoutMs?: number }
  export type PluginRequestArgs<K extends keyof PluginRequests> =
    undefined extends PluginRequestInput<K>
      ? [input?: PluginRequestInput<K>, options?: PluginRequestOptions]
      : [input: PluginRequestInput<K>, options?: PluginRequestOptions]
  /** A name the plugin did not declare, which then carries any JSON. */
  export type Undeclared<N extends string, Declared> = N extends keyof Declared ? never : N
  /** Your plugin's own worker. */
  export type PluginBridgeApi = {
    /** Runs the worker handler `orca.panels.handle(name)` registered, starting the worker if it
     *  is not running. Rejects with `unknown_method` (no such handler), `timeout`, `unavailable`
     *  (no worker), or the `code` the handler threw. */
    request<K extends keyof PluginRequests>(
      name: K,
      ...args: PluginRequestArgs<K>
    ): Promise<PluginRequestOutput<K>>
    request<N extends string>(
      name: Undeclared<N, PluginRequests>,
      input?: JsonValue,
      options?: PluginRequestOptions
    ): Promise<JsonValue>
    /** What the worker posts with `orca.panels.post(event, payload)`. */
    on<K extends keyof PluginPanelEvents>(
      event: K,
      handler: (payload: PluginPanelEvents[K]) => void
    ): Disposable
    on<N extends string>(
      event: Undeclared<N, PluginPanelEvents>,
      handler: (payload: JsonValue) => void
    ): Disposable
  }
  /** A key someone (you, another panel, the worker or the person in Settings) changed. */
  export type DataChange = { key: string }
  /** The plugin's own JSON store (`storage:own`), the same one its worker uses. */
  export type StorageApi = {
    /** `null` when the key is absent. */
    get(key: string): Promise<JsonValue | null>
    set(key: string, value: JsonValue): Promise<void>
    delete(key: string): Promise<void>
    keys(): Promise<string[]>
    onDidChange(listener: (change: DataChange) => void): Disposable
  }
  /** The plugin's settings (`settings:own`): those it declares in `contributes.settings` read as
   *  their `default` until the person changes them in Settings. */
  export type SettingsApi = {
    get(): Promise<Record<string, JsonValue>>
    get(key: string): Promise<JsonValue | undefined>
    /** Declared settings refuse a value of the wrong type with `action_failed`. */
    set(key: string, value: JsonValue): Promise<void>
    onDidChange(listener: (change: DataChange) => void): Disposable
  }
  /** The plugin's encrypted secrets (`secrets:own`). */
  export type SecretsApi = {
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
    delete(key: string): Promise<void>
  }
  export const plugin: PluginBridgeApi
  export const storage: StorageApi
  export const settings: SettingsApi
  export const secrets: SecretsApi
}
