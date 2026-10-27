// Keep create form as modal floor under other drawers; empty transparent host swallows taps and dropped transition timer could strand user (#16165).

export function resolveNewWorktreeFormSheetVisible(input: {
  modalVisible: boolean
  drawerView: string
}): boolean {
  if (!input.modalVisible) {
    return false
  }
  return (
    input.drawerView === 'form' ||
    input.drawerView === 'source' ||
    input.drawerView === 'transition'
  )
}
