// Author typings for Orca components panels (`"ui": "components"`); `orca plugin types` installs
// them with types/orca-services.d.ts, which adds `shell`, `files`, `on`, `plugin`, `storage`,
// `settings` and `secrets` to this module. Mirrors src/shared/plugins/declarative/ (checked by
// plugin-declarative-typings.test.ts); host methods are generated from the host API.

declare module 'orca' {
  export type OrcaElement = { readonly $$typeof: symbol }
  export type OrcaNode =
    | OrcaElement
    | string
    | number
    | boolean
    | null
    | undefined
    | readonly OrcaNode[]
  /** Catalog tags are JSX-only: write `<Stack>`, never call `Stack()`. */
  export type OrcaComponent<P> = (props: P) => OrcaNode
  /** Read with `read()`; reading while rendering re-renders when it changes. */
  export type ReadonlyAtom<T> = { readonly __orcaAtom: T }
  /** Changed with `set()` or `update()`. */
  export type Atom<T> = ReadonlyAtom<T> & { readonly __orcaWritable: true }
  export type Disposable = { dispose(): void }
  export type Theme = { colorScheme: 'light' | 'dark' }
  export type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { [key: string]: JsonValue }

  export type Gap = 'none' | 'xs' | 'sm' | 'md' | 'lg'
  export type Align = 'start' | 'center' | 'end' | 'stretch'
  /** The one colour vocabulary every component shares. */
  export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
  export type Size = 'xs' | 'sm' | 'md'
  export type Variant = 'solid' | 'outline' | 'ghost'
  export type Press = () => unknown
  /** The same names as a manifest panel's `icon`; any other name shows a fallback glyph. */
  export type IconName =
    | 'activity'
    | 'bar-chart-3'
    | 'bell'
    | 'blocks'
    | 'book'
    | 'bot'
    | 'bug'
    | 'calendar'
    | 'cloud'
    | 'code'
    | 'database'
    | 'file-text'
    | 'flag'
    | 'folder'
    | 'gauge'
    | 'globe'
    | 'hammer'
    | 'layers'
    | 'lightbulb'
    | 'package'
    | 'plug'
    | 'puzzle'
    | 'rocket'
    | 'star'
    | 'terminal'
    | 'wrench'
    | 'zap'
    | 'add'
    | 'remove'
    | 'delete'
    | 'edit'
    | 'refresh'
    | 'search'
    | 'settings'
    | 'check'
    | 'close'
    | 'info'
    | 'warning'
    | 'error'
    | 'open-external'
    | 'copy'
    | 'download'
    | 'upload'
    | 'play'
    | 'pause'
    | 'stop'
    | 'more'
    | 'expand'
    | 'collapse'
    | 'next'
    | 'filter'
    | 'branch'
    | 'file'
    | 'agent'
    | 'link'

  type WithChildren = { children?: OrcaNode }
  type Leaf = { children?: never }

  export type StackProps = WithChildren & { gap?: Gap; align?: Align }
  export type RowProps = WithChildren & {
    gap?: Gap
    align?: Align
    justify?: 'start' | 'center' | 'end' | 'between'
    wrap?: boolean
  }
  export type TextProps = WithChildren & {
    tone?: Tone
    muted?: boolean
    size?: Size
    weight?: 'regular' | 'medium' | 'semibold'
    truncate?: boolean
  }
  export type HeadingProps = WithChildren & { level?: 1 | 2 | 3 }
  export type ButtonProps = WithChildren & {
    variant?: Variant
    tone?: Tone
    size?: Size
    icon?: IconName
    disabled?: boolean
    onPress?: Press
  }
  export type IconButtonProps = Leaf & {
    icon: IconName
    /** Accessible name and tooltip. */
    label: string
    variant?: Variant
    tone?: Tone
    size?: Size
    disabled?: boolean
    onPress?: Press
  }
  export type BadgeProps = WithChildren & { tone?: Tone }
  export type CardProps = WithChildren & { title?: string; description?: string }
  export type ListProps = WithChildren & { label?: string }
  /** With `onPress` the whole row is the press target, so it cannot contain other controls. */
  export type ListItemProps = WithChildren & {
    title?: string
    description?: string
    icon?: IconName
    current?: boolean
    disabled?: boolean
    onPress?: Press
  }
  /**
   * Orca keeps the text as the person types. `defaultValue` seeds it; a changed `value` replaces
   * it (an echo of what was typed does not). `value` without `onChange` is read-only.
   */
  export type InputProps = Leaf & {
    label: string
    labelHidden?: boolean
    value?: string
    defaultValue?: string
    placeholder?: string
    type?: 'text' | 'search' | 'password'
    maxLength?: number
    invalid?: boolean
    disabled?: boolean
    onChange?: (value: string) => void
    onSubmit?: (value: string) => void
  }
  export type SwitchProps = Leaf & {
    label: string
    checked?: boolean
    defaultChecked?: boolean
    disabled?: boolean
    onChange?: (checked: boolean) => void
  }
  export type SelectProps = Leaf & {
    label: string
    labelHidden?: boolean
    value?: string
    defaultValue?: string
    placeholder?: string
    options: readonly { value: string; label: string; disabled?: boolean }[]
    disabled?: boolean
    onChange?: (value: string) => void
  }
  export type SeparatorProps = Leaf & { orientation?: 'horizontal' | 'vertical' }
  export type ProgressProps = Leaf & { label: string; labelHidden?: boolean; value?: number }
  export type SpinnerProps = Leaf & { label: string; labelHidden?: boolean }
  export type EmptyStateProps = WithChildren & {
    title: string
    description?: string
    icon?: IconName
  }
  export type LinkProps = WithChildren & { href?: string; onPress?: Press }
  export type CodeProps = WithChildren & { block?: boolean }

  export const Stack: OrcaComponent<StackProps>
  export const Row: OrcaComponent<RowProps>
  export const Text: OrcaComponent<TextProps>
  export const Heading: OrcaComponent<HeadingProps>
  export const Button: OrcaComponent<ButtonProps>
  export const IconButton: OrcaComponent<IconButtonProps>
  export const Badge: OrcaComponent<BadgeProps>
  export const Card: OrcaComponent<CardProps>
  export const List: OrcaComponent<ListProps>
  export const ListItem: OrcaComponent<ListItemProps>
  export const Input: OrcaComponent<InputProps>
  export const Switch: OrcaComponent<SwitchProps>
  export const Select: OrcaComponent<SelectProps>
  export const Separator: OrcaComponent<SeparatorProps>
  export const Progress: OrcaComponent<ProgressProps>
  export const Spinner: OrcaComponent<SpinnerProps>
  export const EmptyState: OrcaComponent<EmptyStateProps>
  export const Link: OrcaComponent<LinkProps>
  export const Code: OrcaComponent<CodeProps>

  export const Fragment: unique symbol
  export function h(type: unknown, props: object | null, ...children: OrcaNode[]): OrcaElement

  /**
   * Where a keyed atom survives: this panel run, every run of the plugin, per workspace, or the
   * plugin's own storage under the atom's key (`storage:own`), shared with its worker and other
   * panels and kept current when they change it.
   */
  export type PersistScope = 'memory' | 'plugin' | 'workspace' | 'storage'
  export type AtomOptions<T> = {
    /** Persisted values must be plain JSON; they load before the first render. `storage` values
     *  are stored as they are, so `version` and `migrate` do not apply to them. */
    persist?: PersistScope
    /** Bump when the stored shape changes; `migrate` then receives the older value. */
    version?: number
    migrate?: (stored: JsonValue, fromVersion: number) => T
  }
  /** State for this panel run. */
  export function atom<T>(initial: T): Atom<T>
  /** Named state, unique per plugin, optionally persisted. */
  export function atom<T>(key: string, initial: T, options?: AtomOptions<T>): Atom<T>
  /** Computed from other atoms; reading it while rendering subscribes to what it reads. */
  export function derived<T>(compute: () => T): ReadonlyAtom<T>
  export function read<T>(atom: ReadonlyAtom<T>): T
  /** Stores `value` as is (functions included). Batched; throws while rendering. */
  export function set<T>(atom: Atom<T>, value: T): void
  /** Replaces the value with `updater(previous)`. Batched; throws while rendering. */
  export function update<T>(atom: Atom<T>, updater: (previous: T) => T): void
  /** Optional: the module's default export is mounted automatically. */
  export function mount(component: () => OrcaNode): void

  /** Passed to the module's optional `export function setup(ctx)`. */
  export type PanelContext = {
    /** Disposed when the panel closes or reloads. */
    subscriptions: Disposable[]
    /** Aborts when the panel closes or reloads. */
    signal: AbortSignal
    /** True while the person can see the panel. */
    visible: ReadonlyAtom<boolean>
    panel: { id: string }
  }
  /** Runs once, after persisted atoms load and before the first render. */
  export type PanelSetup = (ctx: PanelContext) => void | (() => void)

  export type HostCallOptions = { signal?: AbortSignal; timeoutMs?: number }
  /** Rejections carry a `code` (`not_permitted`, `capability_denied`, `timeout`, ...). */
  export type HostError = Error & { code: string; retryable: boolean; retryAfterMs?: number }
  // <generated: host methods, from plugin-host-api.ts>
  export type HostMethods = {
    /** Branch, name and terminal ids of the focused workspace, or null when none is focused. */
    "workspace.readContext": { params: Record<string, never> | undefined; result: { branch: string; displayName: string; terminals: { id: string; title?: string }[] } | null }
    /** Shows a desktop notification. */
    "notifications.show": { params: { title: string; body?: string }; result: { delivered: boolean } }
    /** Reads a JSON value from the plugin's private store; null when absent. */
    "storage.get": { params: { key: string }; result: { value: JsonValue } }
    /** Writes a JSON value to the plugin's private store. */
    "storage.set": { params: { key: string; value: JsonValue }; result: { ok: true } }
    /** Removes a key from the plugin's private store. */
    "storage.delete": { params: { key: string }; result: { ok: true } }
    /** Lists the keys in the plugin's private store. */
    "storage.keys": { params: Record<string, never> | undefined; result: { keys: string[] } }
    /** Reads a secret from the plugin's encrypted secrets file; null when absent. */
    "secrets.get": { params: { key: string }; result: { value: string | null } }
    /** Stores a secret in the plugin's encrypted secrets file. */
    "secrets.set": { params: { key: string; value: string }; result: { ok: true } }
    /** Removes a secret from the plugin's encrypted secrets file. */
    "secrets.delete": { params: { key: string }; result: { ok: true } }
    /** How secrets are protected at rest: `os-keyring`, or `unavailable` (no OS key store, or Linux `basic_text`), where `secrets.set` fails. */
    "secrets.protection": { params: Record<string, never> | undefined; result: { status: "os-keyring" | "unavailable" } }
    /** Reads every setting the plugin owns. */
    "settings.get": { params: Record<string, never> | undefined; result: { settings: Record<string, JsonValue> } }
    /** Writes one setting the plugin owns. */
    "settings.set": { params: { key: string; value: JsonValue }; result: { ok: true } }
    /** Opens an http:, https: or mailto: URL in the default browser. Needs a click or key press in the frame; desktop app only. Orca asks the person before an http(s) host the plugin was not allowed; `opened` is false if they cancel. */
    "shell.openExternal": { params: { url: string }; result: { opened: boolean; reason?: "cancelled" | "consent-unavailable" } }
    /** Offers data (a string or ArrayBuffer, up to 64 MiB) in Orca's save dialog; the plugin never learns the path. Needs a click or key press in the frame; desktop app only. */
    "files.saveAs": { params: { suggestedName?: string; mimeType?: string; data: string | ArrayBuffer }; result: { status: "saved" | "cancelled" } }
    /** Asks the plugin's own worker to run the handler it registered with `orca.panels.handle(name)`, starting the worker if needed; resolves with what the handler returned. `unknown_method` when no handler has that name. */
    "plugin.request": { params: { name: string; input?: JsonValue; timeoutMs?: number }; result: { output: JsonValue } }
    /** The agents in the focused workspace: their terminal, title, agent kind and status. `agent.status.changed` reports each change after. */
    "agents.list": { params: Record<string, never> | undefined; result: { agents: { terminalId: string | null; title: string | null; agent: string | null; state: "working" | "blocked" | "waiting" | "done"; stateStartedAt: number }[] } }
    /** Delivers a workspace or agent event to this panel as `orca.on(event)`; needs the event's read capability. The frame APIs call it for you. */
    "events.subscribe": { params: { event: "workspace.created" | "workspace.removed" | "agent.status.changed" | "workspace.changed" }; result: { ok: true } }
  }
  /** Workspace and agent events `on(event)` delivers, with the read capability of their domain. */
  export type PluginEvents = {
    /** A worktree workspace was created. */
    "workspace.created": { workspaceId: string; kind: "worktree" | "folder"; path: string; branch: string }
    /** A worktree workspace was removed. */
    "workspace.removed": { workspaceId: string; kind: "worktree" | "folder"; path: string }
    /** An agent in a terminal pane changed status; `workspaceId` is null when Orca cannot tie the pane to a workspace, and `terminalId` names its terminal when Orca lists it. */
    "agent.status.changed": { workspaceId: string | null; paneKey: string; terminalId?: string; title?: string; state: "working" | "blocked" | "waiting" | "done"; receivedAt: number; mainAgent?: { state: "working" | "blocked" | "waiting" | "done"; outcome?: "success" | "failure" | "cancellation" | "superseded" | "interruption" | "unconfirmed"; stateStartedAt: number } }
    /** The focused workspace changed, or its terminals were opened, closed or renamed; `context` is what `workspace.readContext` now answers. */
    "workspace.changed": { context: { branch: string; displayName: string; terminals: { id: string; title?: string }[] } | null }
  }
  // </generated>
  export type HostMethod = keyof HostMethods
  export const host: {
    call<K extends HostMethod>(
      method: K,
      ...args: Record<string, never> extends HostMethods[K]['params']
        ? [params?: HostMethods[K]['params'], options?: HostCallOptions]
        : [params: HostMethods[K]['params'], options?: HostCallOptions]
    ): Promise<HostMethods[K]['result']>
    /** Whether this Orca offers `method` to this panel. */
    has(method: string): boolean
  }
  /** The host API this Orca implements. */
  export const api: { readonly major: number; readonly minor: number }
  export const env: {
    /** Orca's UI language (BCP-47). */
    readonly locale: string
    /** Reading it while rendering re-renders on light/dark switches. */
    readonly theme: Theme
    readonly client: 'desktop'
  }
  export type ComponentName =
    | 'Stack'
    | 'Row'
    | 'Text'
    | 'Heading'
    | 'Button'
    | 'IconButton'
    | 'Badge'
    | 'Card'
    | 'List'
    | 'ListItem'
    | 'Input'
    | 'Switch'
    | 'Select'
    | 'Separator'
    | 'Progress'
    | 'Spinner'
    | 'EmptyState'
    | 'Link'
    | 'Code'
  export const ui: {
    /** Grows with the component catalog. */
    readonly catalog: number
    /** Whether this Orca draws `component` (and accepts `prop` on it, when given). */
    has(component: string, prop?: string): boolean
  }
}

declare module 'orca/jsx-runtime' {
  import type { OrcaElement, OrcaNode } from 'orca'
  export { Fragment } from 'orca'
  export function jsx(type: unknown, props: object, key?: string | number): OrcaElement
  export function jsxs(type: unknown, props: object, key?: string | number): OrcaElement
  export namespace JSX {
    type Element = OrcaElement
    type ElementType = (props: never) => OrcaNode
    type ElementChildrenAttribute = { children: unknown }
    type IntrinsicAttributes = { key?: string | number }
    // No lowercase tags: panels never render DOM.
    type IntrinsicElements = {}
  }
}

declare module 'orca/jsx-dev-runtime' {
  import type { OrcaElement } from 'orca'
  export { Fragment, JSX } from 'orca/jsx-runtime'
  export function jsxDEV(type: unknown, props: object, key?: string | number): OrcaElement
}
