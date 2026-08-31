// Why: the create form is the modal's floor. Every other drawer layers above it,
// so the shared modal host is never mounted with no sheet in it — a beat with a
// transparent full-screen host swallows taps, and a dropped transition timer
// would strand the user there with no way back (#16165 follow-up).

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
