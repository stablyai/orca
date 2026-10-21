import React from 'react'
import { CornerDownLeft } from 'lucide-react'

/** The Enter-key badge that trails a filled primary button's label ("Create worktree ⌘↵").
 *  Decorative: the button's name is its label, not the glyphs. */
export function ButtonKeyHint({
  modifierLabel
}: {
  /** The platform modifier shown before ↵ (e.g. "⌘" or "Ctrl"); omit when plain Enter submits. */
  modifierLabel?: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="ml-1 inline-flex items-center gap-0.5 rounded border border-white/20 px-1.5 py-0.5 text-[10px] font-medium leading-none text-current/80"
    >
      {modifierLabel ? <span>{modifierLabel}</span> : null}
      <CornerDownLeft className="size-3" />
    </span>
  )
}
