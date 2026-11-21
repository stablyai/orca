let toggle: HTMLButtonElement | null = null

/** Ref callback for the titlebar's sidebar toggle, so focus fallbacks use this exact button, not a CSS query. */
export function registerTitlebarSidebarToggle(node: HTMLButtonElement | null): void {
  if (node) {
    toggle = node
  }
}

/** Clear only if this node is still the registered one (another titlebar may have mounted since). */
export function unregisterTitlebarSidebarToggle(node: HTMLButtonElement): void {
  if (toggle === node) {
    toggle = null
  }
}

export function getTitlebarSidebarToggle(): HTMLButtonElement | null {
  return toggle?.isConnected ? toggle : null
}
