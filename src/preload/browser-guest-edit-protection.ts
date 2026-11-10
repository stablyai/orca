import {
  BROWSER_GUEST_PROTECTION_CHALLENGE,
  BROWSER_GUEST_PROTECTION_REPORT
} from '../shared/browser/guest-lifecycle/browser-guest-discard-protection'

type ResettableControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement

function isResettableControl(target: EventTarget | undefined): target is ResettableControl {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  )
}

/** Private preload state: page code cannot report itself clean or read the challenge. */
export function installBrowserGuestEditProtection(port: {
  send: (channel: string, payload: unknown) => void
  on: (channel: string, listener: (payload: unknown) => void) => void
}): void {
  const edits = new WeakMap<ResettableControl, number>()
  let editRevision = 0
  let editedControls = 0
  let otherEdits = false
  let generation: string | null = null
  let lastReportedDirty: boolean | undefined
  const report = (snapshot = false): void => {
    const dirty = editedControls > 0 || otherEdits
    if (generation && (snapshot || dirty !== lastReportedDirty)) {
      lastReportedDirty = dirty
      port.send(BROWSER_GUEST_PROTECTION_REPORT, { generation, dirty })
    }
  }
  const edited = (event: Event): void => {
    if (!event.isTrusted) {
      return
    }
    const target = event.composedPath()[0]
    if (isResettableControl(target)) {
      if (!edits.has(target)) {
        editedControls += 1
      }
      edits.set(target, ++editRevision)
    } else {
      // Rich text and closed shadow editors have no native reset operation.
      otherEdits = true
    }
    report()
  }
  document.addEventListener('input', edited, true)
  document.addEventListener('change', edited, true)
  document.addEventListener(
    'reset',
    (event) => {
      const form = event.composedPath()[0]
      if (!event.isTrusted || !(form instanceof HTMLFormElement)) {
        return
      }
      const resetEdits = Array.from(form.elements).flatMap((element) => {
        if (!isResettableControl(element) || element.form !== form) {
          return []
        }
        const revision = edits.get(element)
        return revision === undefined ? [] : [{ element, revision }]
      })
      // The default reset and every page handler must finish before any draft loses protection.
      setTimeout(() => {
        if (event.defaultPrevented) {
          return
        }
        for (const { element, revision } of resetEdits) {
          if (element.isConnected && element.form === form && edits.get(element) === revision) {
            edits.delete(element)
            editedControls -= 1
          }
        }
        report()
      }, 0)
    },
    true
  )
  // A submit may target another frame, return a download, or be handled without saving a draft.
  port.on(BROWSER_GUEST_PROTECTION_CHALLENGE, (payload) => {
    if (typeof payload !== 'string') {
      return
    }
    generation = payload
    report(true)
  })
  window.addEventListener('pageshow', (event) => {
    if (event.isTrusted) {
      port.send(BROWSER_GUEST_PROTECTION_REPORT, { ready: true })
    }
  })
  port.send(BROWSER_GUEST_PROTECTION_REPORT, { ready: true })
}
