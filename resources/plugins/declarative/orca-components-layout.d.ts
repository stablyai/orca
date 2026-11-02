// Orca components panel catalog 2 (since Orca 1.4.247): layout and feedback components. Part of
// the `orca` module with orca.d.ts, orca-components.d.ts and orca-components-data.d.ts.

declare module 'orca' {
  import type { Gap, IconName, Leaf, OrcaComponent, Tone, WithChildren } from 'orca'

  /** Holds only `Tab`; Orca draws the selected tab's children. */
  export type TabsProps = WithChildren & {
    label: string
    value?: string
    defaultValue?: string
    onChange?: (value: string) => void
  }
  export type TabProps = WithChildren & {
    value: string
    label: string
    icon?: IconName
    disabled?: boolean
  }
  export type CollapsibleProps = WithChildren & {
    title: string
    description?: string
    open?: boolean
    defaultOpen?: boolean
    disabled?: boolean
    onChange?: (open: boolean) => void
  }
  /** A row of controls; arrow keys move between them. */
  export type ToolbarProps = WithChildren & { label: string; gap?: Gap }
  export type GridProps = WithChildren & {
    columns?: 1 | 2 | 3 | 4 | 5 | 6
    /** As many columns as fit, each at least this wide; overrides `columns`. */
    minItemWidth?: 'xs' | 'sm' | 'md' | 'lg'
    gap?: Gap
  }
  export type CalloutProps = WithChildren & { tone?: Tone; title?: string; icon?: IconName }
  /** A placeholder while content loads; `label` names it for screen readers. */
  export type SkeletonProps = Leaf & {
    shape?: 'text' | 'block' | 'circle'
    lines?: number
    label?: string
  }

  export const Tabs: OrcaComponent<TabsProps>
  export const Tab: OrcaComponent<TabProps>
  export const Collapsible: OrcaComponent<CollapsibleProps>
  export const Toolbar: OrcaComponent<ToolbarProps>
  export const Grid: OrcaComponent<GridProps>
  export const Callout: OrcaComponent<CalloutProps>
  export const Skeleton: OrcaComponent<SkeletonProps>
}
