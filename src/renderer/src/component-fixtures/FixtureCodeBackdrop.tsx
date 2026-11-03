const CODE_LINES = [
  ['text-sky-400', 'import { useAppStore } from "../../store"'],
  ['text-rose-400', 'export function SortableTab({ tab, isActive }: Props) {'],
  ['text-emerald-400', '  const keybindings = useAppStore((s) => s.keybindings)'],
  ['text-amber-300', '  if (!tab.visible) return null // hidden tabs skip layout'],
  ['text-violet-400', '  return <TabButton active={isActive} title={tab.title} />'],
  ['text-sky-400', '}'],
  ['text-rose-400', 'const TAB_COLORS = ["#3b82f6", "#a855f7", "#ec4899"]'],
  ['text-emerald-400', 'function closeOthers(tabId: string): void {'],
  ['text-amber-300', '  for (const other of tabs) if (other.id !== tabId) close(other)'],
  ['text-violet-400', '}']
] as const

/** Busy, colorful content so translucent overlays show what bleeds through. */
export function FixtureCodeBackdrop({ rows = 3 }: { rows?: number }): React.JSX.Element {
  const lines = Array.from({ length: rows }).flatMap((_, repeat) =>
    CODE_LINES.map(([color, text], line) => ({ id: `${repeat}:${line}`, color, text }))
  )
  return (
    <pre className="m-0 p-3 font-mono text-[12px] leading-5">
      {lines.map(({ id, color, text }) => (
        <div key={id} className={color}>
          {text}
        </div>
      ))}
    </pre>
  )
}
