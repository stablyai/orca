// Test kit for components panels: `orca plugin test` runs *.test.ts(x) files in plain Node.
declare module 'orca/testing' {
  import type { OrcaEvents, OrcaNode, PanelContext } from 'orca'

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
  /** Every field given must match; `text` and `label` match exactly (whitespace folded) or by RegExp. */
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

  export type MockHost = {
    /** Every call that reached the host, in order, refused ones included. */
    readonly calls: readonly { method: string; params: unknown }[]
    callsOf(method: string): unknown[]
    respond(method: string, result: unknown): void
  }
  export type MockHostOptions = {
    /** Granted capabilities; defaults to those the plugin's orca-plugin.json declares. */
    capabilities?: readonly string[]
    /** Each method's answer: a value, or a function of the params that may throw `hostError(...)`. */
    results?: Record<string, unknown>
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
    /** What persisted atoms hold now, by scope and key. */
    readonly persisted: { plugin: Record<string, unknown>; workspace: Record<string, unknown> }
    /** The innermost match, or null. */
    find(query: TestQuery): TestElement | null
    findAll(query: TestQuery): TestElement[]
    /** The drawn tree as plain data, for snapshots; handlers show as `[handler]`. */
    tree(): TreeSnapshot | string | null
    /** Each act grants one gesture (a press) and resolves once the panel has settled. */
    press(target: Target): Promise<void>
    /** Types after what the field holds (`replace` clears it first); `submit` presses Enter. */
    type(
      target: Target,
      text: string,
      options?: { replace?: boolean; submit?: boolean }
    ): Promise<void>
    submit(target: Target): Promise<void>
    toggle(target: Target): Promise<void>
    select(target: Target, value: string): Promise<void>
    /** What Orca shows in an Input, Switch or Select. */
    valueOf(target: Target): unknown
    emit<E extends keyof OrcaEvents>(event: E, payload: OrcaEvents[E]): Promise<void>
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

  /** Node's `node:test`, re-exported so a test type-checks without @types/node. */
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
