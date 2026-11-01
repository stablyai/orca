// Test kit for components panels: `orca plugin test` runs *.test.ts(x) files in plain Node.
declare module 'orca/testing' {
  import type {
    JsonValue,
    OrcaEvents,
    OrcaNode,
    PanelContext,
    PluginPanelEvents,
    PluginRequestInput,
    PluginRequestOutput,
    PluginRequests,
    Undeclared
  } from 'orca'
  import type { OrcaWorkerApi, PluginEventName, PluginEvents } from 'orca/worker'

  /** One element of the drawn panel. Actions take it, or a query that finds it. */
  export type TestElement = {
    type: string
    /** The author's `key`, which `testId` matches. */
    key: string | undefined
    role: string
    /** A control's `label`, or a list item's, card's or empty state's `title`. */
    label: string | undefined
    /** The words a person reads in it, its descendants' included. */
    text: string
    props: Readonly<Record<string, unknown>>
    disabled: boolean
    path: string
  }
  /**
   * Every field given must match; `text` and `label` match exactly (whitespace folded) or by RegExp.
   * Finders see what Orca draws: not the content of unselected tabs or closed Collapsibles.
   */
  export type TestQuery = {
    type?: string
    role?: string
    text?: string | RegExp
    label?: string | RegExp
    testId?: string
  }
  export type TreeSnapshot = {
    type: string
    key?: string
    props?: Record<string, unknown>
    children?: (TreeSnapshot | string)[]
  }
  /** `plugin`: the panel threw. `refused`: Orca would refuse what it drew or persisted. */
  export type PanelIssue = { kind: 'plugin' | 'refused'; message: string; stack?: string }
  export type HostError = Error & { code: string; retryable: boolean; retryAfterMs?: number }

  /** A call Orca itself would refuse, recorded even when the plugin caught the error. */
  export type MockHostRefusal = { method: string; code: string; message: string }
  export type MockHost = {
    /** Every call that reached the host, in order, refused ones included. */
    readonly calls: readonly { method: string; params: unknown }[]
    /** `capability_denied`, `not_permitted`, `invalid_params` or `unknown_method` calls. */
    readonly refusals: readonly MockHostRefusal[]
    callsOf(method: string): unknown[]
    respond(method: string, result: unknown): void
    /** The plugin's storage, settings and secrets as they are now. */
    data(): {
      storage: Record<string, unknown>
      settings: Record<string, unknown>
      secrets: Record<string, unknown>
    }
  }
  /** A stand-in for the plugin's worker: each `plugin.request` name's answer, or a function of
   *  its input (it may throw `hostError(...)`). An unlisted name rejects with `unknown_method`. */
  export type MockRequests = {
    [K in keyof PluginRequests]?:
      | PluginRequestOutput<K>
      | ((input: PluginRequestInput<K>) => PluginRequestOutput<K> | Promise<PluginRequestOutput<K>>)
  } & Record<string, unknown>
  export type MockHostOptions = {
    /** Granted capabilities; defaults to those the plugin's orca-plugin.json declares. */
    capabilities?: readonly string[]
    /** Each method's answer: a value, or a function of the params that may throw `hostError(...)`.
     *  Overrides the built-in storage, settings, secrets and `requests`. */
    results?: Record<string, unknown>
    requests?: MockRequests
    /** What the plugin's storage, settings and secrets hold before the panel runs. Writes land
     *  here, and tell the panel's `onDidChange` listeners and `persist: 'storage'` atoms. */
    storage?: Record<string, JsonValue>
    settings?: Record<string, JsonValue>
    secrets?: Record<string, string>
  }
  /**
   * A stand-in Orca host that refuses what Orca refuses, with the same codes: a missing
   * capability, bad params, a method panels cannot call, and a user-gesture method
   * (`shell.openExternal`, `files.saveAs`) without a press first.
   */
  export function mockHost(options?: MockHostOptions): MockHost
  export function hostError(code: string, message?: string, retryAfterMs?: number): HostError
  /** A persisted value an older version wrote, to test an atom's `migrate`. */
  export function stored(value: unknown, version: number): unknown

  export type MountOptions = {
    host?: MockHost
    theme?: 'light' | 'dark'
    locale?: string
    visible?: boolean
    panelId?: string
    /** Values an earlier run persisted, by atom key; plain values are stored at version 1. */
    persisted?: { plugin?: Record<string, unknown>; workspace?: Record<string, unknown> }
  }
  export type PanelModule = {
    default?: () => OrcaNode
    setup?: (ctx: PanelContext) => void | (() => void)
  }
  type Target = TestElement | TestQuery

  export type TestPanel = {
    readonly host: MockHost
    readonly errors: readonly PanelIssue[]
    /** Props and components Orca would drop, as Orca would warn. */
    readonly warnings: readonly string[]
    /** Host calls Orca would refuse (a missing capability, no press), even ones the panel caught. */
    readonly refusals: readonly MockHostRefusal[]
    /** What persisted atoms hold now, by scope and key; `storage` is the plugin's storage. */
    readonly persisted: {
      plugin: Record<string, unknown>
      workspace: Record<string, unknown>
      storage: Record<string, unknown>
    }
    /** The innermost match, or null. */
    find(query: TestQuery): TestElement | null
    findAll(query: TestQuery): TestElement[]
    /** The drawn tree as plain data, for snapshots; handlers show as `[handler]`. */
    tree(): TreeSnapshot | string | null
    /** One line per thing a person notices first: headings, callouts, empty states, table and
     *  tree sizes, the selected tab, loading placeholders, danger or warning text. */
    summary(): string[]
    /** Each act grants one gesture (a press) and resolves once the panel has settled. */
    press(target: Target): Promise<void>
    /** Types after what the field holds (`replace` clears it first); `submit` presses Enter. */
    type(
      target: Target,
      text: string,
      options?: { replace?: boolean; submit?: boolean }
    ): Promise<void>
    submit(target: Target): Promise<void>
    /** A Switch, Checkbox or Collapsible. */
    toggle(target: Target): Promise<void>
    /** A Select or RadioGroup option, or a Tabs tab, by value. */
    select(target: Target, value: string): Promise<void>
    slide(target: Target, value: number): Promise<void>
    /** Table: a header click (ascending first, then flipping). */
    sort(target: Target, column: string): Promise<void>
    /** Table: replaces the selection with exactly these rows. */
    selectRows(target: Target, keys: readonly string[]): Promise<void>
    /** Table: Enter or a double click on a row. */
    activateRow(target: Target, key: string): Promise<void>
    /** Table: scrolls to the end of the loaded rows (needs `hasMore` and `onLoadMore`). */
    loadMore(target: Target): Promise<void>
    /** Tree: expand or collapse an item, calling `onToggle`. */
    expand(target: Target, key: string): Promise<void>
    collapse(target: Target, key: string): Promise<void>
    selectItem(target: Target, key: string): Promise<void>
    activateItem(target: Target, key: string): Promise<void>
    /** Tree: the items Orca shows expanded. */
    expandedOf(target: Target): string[]
    /** Table: the column keys Orca shows at `width` px (wide when omitted), after `hideBelow`. */
    columnsOf(target: Target, view?: { width?: number }): string[]
    /** Table: row keys in the order Orca draws them. */
    rowsOf(target: Target): string[]
    /** What Orca shows in a value control: text, a flag, a number, a tab, or selected keys. */
    valueOf(target: Target): unknown
    /** An Orca event: `theme`, or a workspace or agent event the panel subscribed to. */
    emit<E extends keyof OrcaEvents>(event: E, payload: OrcaEvents[E]): Promise<void>
    /** What the plugin's worker posts with `orca.panels.post`; `plugin.on` handlers hear it. */
    post<K extends keyof PluginPanelEvents>(event: K, payload: PluginPanelEvents[K]): Promise<void>
    post<N extends string>(
      event: Undeclared<N, PluginPanelEvents>,
      payload?: JsonValue
    ): Promise<void>
    setVisible(visible: boolean): Promise<void>
    rerender(): Promise<void>
    settled(): Promise<void>
    /** Ends the run: setup cleanup, `ctx.signal` and subscriptions, as when the panel closes. */
    unmount(): Promise<void>
  }
  /**
   * Mounts a panel module (`import * as panel from './panel'`) or its component, with the real
   * runtime and Orca's own checks, and resolves once it has drawn. Mounting again starts over:
   * every atom goes back to its initial value.
   */
  export function mount(
    target: PanelModule | (() => OrcaNode),
    options?: MountOptions
  ): Promise<TestPanel>

  /** A worker `main` module: `import * as worker from './worker'`. */
  export type WorkerModule = {
    default?: (orca: OrcaWorkerApi) => unknown
    deactivate?: () => unknown
    [name: string]: unknown
  }
  export type MountWorkerOptions = {
    host?: MockHost
    /** Events delivered to the worker; defaults to the manifest's `contributes.events`. */
    events?: readonly string[]
    /** Commands it may register; defaults to the manifest's `contributes.commands`. */
    commands?: readonly string[]
  }
  export type TestWorker = {
    readonly host: MockHost
    /** What the worker passed to `orca.log`. */
    readonly logs: readonly string[]
    readonly refusals: readonly MockHostRefusal[]
    /** What the worker sent with `orca.panels.post`, in order. */
    readonly posts: readonly { event: string; payload?: unknown; panel?: string }[]
    /** Delivers an event as Orca would (checked against Orca's payload schema) and waits for every handler. */
    emit<E extends PluginEventName>(event: E, payload: PluginEvents[E]): Promise<void>
    /** Runs a registered command and resolves with its result. */
    command(commandId: string, args?: unknown): Promise<unknown>
    /** A panel's `plugin.request`, answered by the worker's `orca.panels.handle`; `panel` names the
     *  calling panel's contribution id. An unhandled name rejects with `unknown_method`. */
    request<K extends keyof PluginRequests>(
      name: K,
      input?: PluginRequestInput<K>,
      caller?: { panel?: string }
    ): Promise<PluginRequestOutput<K>>
    request<N extends string>(
      name: Undeclared<N, PluginRequests>,
      input?: JsonValue,
      caller?: { panel?: string }
    ): Promise<unknown>
    /** Runs the module's `deactivate` and drops its handlers. */
    deactivate(): Promise<void>
  }
  /**
   * Calls the worker's default-exported `activate(orca)` with the `orca` object Orca passes, backed
   * by `mockHost` (worker methods, the manifest's capabilities). `.ts` mains load as Orca loads them.
   */
  export function mountWorker(
    module: WorkerModule,
    options?: MountWorkerOptions
  ): Promise<TestWorker>

  /** One render `orca plugin check` makes: the host it runs on, persisted values, and Orca events
   *  delivered after it first draws. */
  export type CheckScenario = MockHostOptions & {
    persisted?: MountOptions['persisted']
    theme?: 'light' | 'dark'
    events?: readonly {
      [E in keyof OrcaEvents]: { event: E; payload: OrcaEvents[E] }
    }[keyof OrcaEvents][]
  }
  /**
   * Named scenarios for `orca plugin check`, as the default export of `<entry>.check.ts` beside the
   * panel (`src/panel.check.ts` for `src/panel.tsx`). Check renders the panel once per scenario,
   * with the plugin's worker on the same host; without the file it renders once with defaults.
   */
  export function defineCheck<S extends Record<string, CheckScenario>>(scenarios: S): S

  /** Node's `node:test`, re-exported so a test type-checks without the Node typings. */
  export function test(name: string, fn: () => unknown): Promise<void>
  export function describe(name: string, fn: () => unknown): Promise<void>
  export function beforeEach(fn: () => unknown): void
  export function afterEach(fn: () => unknown): void
  /** Node's `node:assert/strict`, the common checks. */
  export const assert: {
    (value: unknown, message?: string): asserts value
    ok(value: unknown, message?: string): asserts value
    equal<T>(actual: unknown, expected: T, message?: string): asserts actual is T
    notEqual(actual: unknown, expected: unknown, message?: string): void
    deepEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void
    match(value: string, pattern: RegExp, message?: string): void
    throws(fn: () => unknown, expected?: RegExp | Error | ((error: unknown) => boolean)): void
    rejects(
      promise: Promise<unknown> | (() => Promise<unknown>),
      expected?: RegExp | Error | ((error: unknown) => boolean)
    ): Promise<void>
    fail(message?: string): never
  }
}
