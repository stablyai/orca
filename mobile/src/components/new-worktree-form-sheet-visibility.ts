// Why: pin the create form under the fill-height name picker (and during that
// picker's close transition) so dismiss reveals the original content height.

export function resolveNewWorktreeFormSheetVisible(input: {
  modalVisible: boolean
  drawerView: string
  formPinnedUnderSource: boolean
}): boolean {
  if (!input.modalVisible) {
    return false
  }
  if (input.drawerView === 'form' || input.drawerView === 'source') {
    return true
  }
  return input.drawerView === 'transition' && input.formPinnedUnderSource
}
