// Orca components panel catalog 2 (since Orca 1.4.247) and later: data, content and code
// components. Part of the `orca` module with orca.d.ts, orca-components.d.ts and
// orca-components-layout.d.ts.

declare module 'orca' {
  import type { IconName, Leaf, MaxHeight, OrcaComponent, Tone } from 'orca'

  export type TableColumn = {
    /** Names the cell in each row's `cells`. */
    key: string
    label: string
    align?: 'start' | 'center' | 'end'
    width?: 'auto' | 'xs' | 'sm' | 'md' | 'lg'
    /** An `auto` column's floor (`xs` 4rem, `sm` 6rem, `md` 9rem), so it keeps room when narrow. */
    minWidth?: 'auto' | 'xs' | 'sm' | 'md'
    /** Drop the column while the table is narrower than `sm` (360px) or `md` (480px). */
    hideBelow?: 'sm' | 'md'
    sortable?: boolean
  }
  /** How a relative time reads: `long` "5 minutes ago", `short` "5m ago", `duration` "5m". */
  export type RelativeTimeFormat = 'long' | 'short' | 'duration'
  /** A cell Orca keeps current, e.g. `{ type: 'relative', at: agent.stateStartedAt }`. */
  export type RelativeTimeCell = { type: 'relative'; at: number; format?: RelativeTimeFormat }
  export type TableCell = string | number | boolean | null | RelativeTimeCell
  export type TableRow = { key: string; cells: Record<string, TableCell>; disabled?: boolean }
  export type TableSort = { column: string; direction: 'asc' | 'desc' }
  /**
   * Rows scroll inside the table and only those in view are drawn. Sorting is yours: Orca
   * reports `onSortChange` and draws the rows in the order you give. With `hasMore`, scrolling
   * near the last row calls `onLoadMore` once per length of `rows`.
   */
  export type TableProps = Leaf & {
    label: string
    columns: readonly TableColumn[]
    rows: readonly TableRow[]
    sort?: TableSort
    selectionMode?: 'none' | 'single' | 'multiple'
    selected?: readonly string[]
    defaultSelected?: readonly string[]
    hasMore?: boolean
    loading?: boolean
    emptyText?: string
    maxHeight?: MaxHeight
    onSortChange?: (sort: TableSort) => void
    onSelectionChange?: (selection: { keys: string[] }) => void
    /** Enter or a double click on a row. */
    onRowAction?: (row: { key: string }) => void
    onLoadMore?: () => void
  }
  export type TreeItem = {
    key: string
    label: string
    description?: string
    icon?: IconName
    disabled?: boolean
    /** Children exist but are not loaded: expanding shows a loading row and calls `onToggle`. */
    hasChildren?: boolean
    children?: readonly TreeItem[]
  }
  /** Arrow keys move, expand and collapse; Enter calls `onAction`. Keys are unique across levels. */
  export type TreeProps = Leaf & {
    label: string
    items: readonly TreeItem[]
    selected?: string
    defaultSelected?: string
    /**
     * Open items, when the plugin keeps them (update it from `onToggle`). Orca's own record is lost
     * when the Tree unmounts, for example on a tab switch.
     */
    expanded?: readonly string[]
    defaultExpanded?: readonly string[]
    maxHeight?: MaxHeight
    onSelect?: (item: { key: string }) => void
    onToggle?: (item: { key: string; expanded: boolean }) => void
    onAction?: (item: { key: string }) => void
  }
  /** GitHub-flavoured Markdown, sanitized. Links open like `Link`; images must be plugin files. */
  export type MarkdownProps = Leaf & { content: string }
  /** Read-only code, highlighted when Orca knows `language` (built in or from a syntax plugin). */
  export type CodeViewProps = Leaf & {
    code: string
    language?: string
    label?: string
    lineNumbers?: boolean
    wrap?: boolean
    maxHeight?: MaxHeight
  }
  /** An image file in the plugin (`assets/logo.png`); never a URL. `alt: ''` for decoration. */
  export type ImageProps = Leaf & {
    src: string
    alt: string
    size?: 'xs' | 'sm' | 'md' | 'lg' | 'full'
    fit?: 'contain' | 'cover'
    rounded?: boolean
  }
  export type KeyValueItem = {
    label: string
    value: string | number | boolean | null
    tone?: Tone
    code?: boolean
  }
  export type KeyValueProps = Leaf & { label?: string; items: readonly KeyValueItem[] }
  /**
   * Since 1.4.247 (`ui.catalog` 3): a time Orca keeps current ("5m ago") with no polling. Inline:
   * it may sit inside `Text`.
   */
  export type RelativeTimeProps = Leaf & {
    /** Milliseconds since the epoch, e.g. `Date.now()` or an agent's `stateStartedAt`. */
    at: number
    format?: RelativeTimeFormat
    tone?: Tone
    muted?: boolean
  }

  export const RelativeTime: OrcaComponent<RelativeTimeProps>
  export const Table: OrcaComponent<TableProps>
  export const Tree: OrcaComponent<TreeProps>
  export const Markdown: OrcaComponent<MarkdownProps>
  export const CodeView: OrcaComponent<CodeViewProps>
  export const Image: OrcaComponent<ImageProps>
  export const KeyValue: OrcaComponent<KeyValueProps>

  // Catalog 5: check `ui.has('CodeInput')` when your minimum Orca is older.
  export type CompletionKind = 'field' | 'operator' | 'function' | 'keyword' | 'value'
  /** A suggestion for the word before the cursor; Orca filters them as the person types. */
  export type Completion = {
    label: string
    detail?: string
    /** Inserted instead of `label`. */
    insert?: string
    kind?: CompletionKind
  }
  /** A range of `value` drawn underlined, in UTF-16 indexes (`text.slice(from, to)`). */
  export type Diagnostic = {
    from: number
    to: number
    message: string
    tone?: 'danger' | 'warning'
  }
  /**
   * Editable code, highlighted when Orca knows `language`. Typing a word offers the matching
   * `completions` (Ctrl+Space shows them all); `diagnostics` are dropped while the text on screen
   * is newer than the `value` they were computed for.
   */
  export type CodeInputProps = Leaf & {
    label: string
    labelHidden?: boolean
    value?: string
    defaultValue?: string
    placeholder?: string
    language?: string
    /**
     * Visible lines, 1 to 20 (default 1). With 1 the text is one line that wraps, and Enter
     * submits; with more, Enter breaks the line and Cmd/Ctrl+Enter submits. Shift+Enter always
     * breaks the line; a new line keeps the indent of the one it breaks.
     */
    rows?: number
    /** Grows with its text up to this many lines (default `rows`), then scrolls. */
    maxRows?: number
    maxLength?: number
    invalid?: boolean
    disabled?: boolean
    completions?: Completion[]
    /**
     * Characters that open and close a string (for JavaScript: single quote, double quote and
     * backtick). Typing inside one offers no `completions`. A backslash escapes the next
     * character; a line break ends a string opened by any quote but a backtick. Ctrl+Space still
     * offers them.
     */
    quotes?: string
    diagnostics?: Diagnostic[]
    onChange?: (value: string) => void
    onSubmit?: (value: string) => void
  }
  export const CodeInput: OrcaComponent<CodeInputProps>
}
