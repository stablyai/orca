const OPACITY_TOKEN = '--orca-sidebar-opacity'

/** Lets main.css thin the sidebars over the window material; at 1 they keep their opaque fill. */
export function applySidebarGlass(opacity: number): void {
  const root = document.documentElement
  const clamped = Math.min(1, Math.max(0, Number.isFinite(opacity) ? opacity : 1))
  if (clamped >= 1) {
    delete root.dataset.sidebarGlass
    root.style.removeProperty(OPACITY_TOKEN)
    return
  }
  root.dataset.sidebarGlass = ''
  root.style.setProperty(OPACITY_TOKEN, `${Number((clamped * 100).toFixed(2))}%`)
}
