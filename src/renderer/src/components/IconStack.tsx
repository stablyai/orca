import React from 'react'

export type IconStackItem = {
  key: string
  icon: React.ReactNode
}

/** Small round icons drawn slightly overlapping, e.g. agent or connector logos. */
export function IconStack({ items }: { items: readonly IconStackItem[] }): React.JSX.Element {
  return (
    <span className="inline-flex shrink-0 items-center -space-x-0.5 pl-0.5">
      {items.map((item) => (
        <span
          key={item.key}
          className="inline-flex size-4 items-center justify-center rounded-full border border-worktree-sidebar-border/70 bg-worktree-sidebar"
        >
          {item.icon}
        </span>
      ))}
    </span>
  )
}
