import { scope } from './document-scope'
import { notify } from './host-notify'
import { cancelSelect } from './selection-range'
import { repositionOverlay } from './selection-overlay'

export function startSelectionMenuButtons() {
  scope.btnCopy!.addEventListener('click', function (e) {
    e.preventDefault()
    e.stopPropagation()
    if (!scope.term) {
      return
    }
    const text = scope.term.getSelection ? scope.term.getSelection() : ''
    if (text && text.length > 0) {
      notify({ type: 'selection', text: text })
    } else {
      cancelSelect()
    }
  })
  scope.btnSelAll!.addEventListener('click', function (e) {
    e.preventDefault()
    e.stopPropagation()
    if (!scope.term) {
      return
    }
    try {
      scope.term.selectAll()
      const b = scope.term.buffer.active
      scope.sel = {
        anchor: { col: 0, row: 0 },
        focus: { col: scope.term.cols - 1, row: b.length - 1 },
        activeHandle: null
      }
      repositionOverlay()
    } catch {}
  })
}
