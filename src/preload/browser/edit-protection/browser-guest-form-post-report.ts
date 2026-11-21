import { BROWSER_GUEST_PROTECTION_REPORT } from '../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'

/**
 * Reports the action URL of a form POST that replaces the guest's page, so main can keep the
 * result page from being discarded (a restore cannot repeat the POST). Runs in every frame: an
 * embedded form can target the top page.
 */
export function installBrowserGuestFormPostReport(port: {
  send: (channel: string, payload: unknown) => void
}): void {
  const lastSubmitByForm = new WeakMap<HTMLFormElement, SubmitEvent>()
  window.addEventListener(
    'submit',
    (event) => {
      if (event.isTrusted && event.target instanceof HTMLFormElement) {
        lastSubmitByForm.set(event.target, event)
      }
    },
    true
  )
  const isTop = window === window.top
  const navigation = isTop ? window.navigation : undefined
  const retract = (formPost: string): void => {
    port.send(BROWSER_GUEST_PROTECTION_REPORT, { formPostCancelled: formPost })
  }
  // The top page's form navigation still pending; another navigation replaces it.
  let pendingForm: string | null = null
  // Fires only for a submission that wasn't cancelled; main matches it to the navigation it starts.
  window.addEventListener(
    'formdata',
    (event) => {
      const formPost = event.isTrusted ? postedFormAction(event.target, lastSubmitByForm) : null
      if (!formPost) {
        return
      }
      port.send(BROWSER_GUEST_PROTECTION_REPORT, { formPost })
      // Withdraw it unless a form navigate event is pending: a real submission reports again from
      // its navigate event; without one (the page removed the form, say) no POST loads. An
      // opaque-origin document (a sandboxed page) fires no navigate events, so its report stays.
      if (navigation && navigation.currentEntry !== null) {
        setTimeout(() => {
          if (pendingForm === null) {
            retract(formPost)
          }
        }, 0)
      }
    },
    true
  )
  // Form events stay inside a shadow root; the top page's own navigation still carries the POST
  // body. Only the top frame listens: an embedded frame's navigation doesn't replace the page.
  if (!navigation) {
    return
  }
  navigation.addEventListener('navigate', (event) => {
    pendingForm = null
    if (!event.isTrusted || !event.formData || event.hashChange) {
      return
    }
    const formPost = event.destination.url
    pendingForm = formPost
    port.send(BROWSER_GUEST_PROTECTION_REPORT, { formPost })
    // This listener runs before the page's; once dispatch ends, retract a navigation it cancelled.
    setTimeout(() => {
      if (event.defaultPrevented && pendingForm === formPost) {
        pendingForm = null
        retract(formPost)
      }
    }, 0)
  })
  // Only a navigation handled in this document settles here: intercepted by the page, or aborted
  // (stopped, or "Stay" at a leave prompt). A cross-document POST unloads this document instead.
  const settled = (event: Event): void => {
    if (event.isTrusted && pendingForm !== null) {
      retract(pendingForm)
      pendingForm = null
    }
  }
  navigation.addEventListener('navigatesuccess', settled)
  navigation.addEventListener('navigateerror', settled)
}

/** The action URL of a POST that replaces the top page; null for GET or another target. */
function postedFormAction(
  target: EventTarget | null,
  lastSubmitByForm: WeakMap<HTMLFormElement, SubmitEvent>
): string | null {
  // `new FormData(form)` fires formdata too. A submission builds its entry list only after its
  // submit event finished dispatching uncancelled; a page handler's FormData runs during it.
  // `form.submit()` fires no submit event: the top frame's Navigation API sees it, and an embedded
  // frame reports it anyway; a `new FormData(form)` report is disproved by the navigation's method.
  if (!(target instanceof HTMLFormElement)) {
    return null
  }
  const recorded = lastSubmitByForm.get(target)
  if (recorded && recorded.eventPhase !== Event.NONE) {
    return null
  }
  lastSubmitByForm.delete(target)
  const submit = recorded && !recorded.defaultPrevented ? recorded : undefined
  if (!submit && window === window.top) {
    return null
  }
  const submitter = submit?.submitter
  const button =
    submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement
      ? submitter
      : null
  const method = button?.hasAttribute('formmethod')
    ? button.formMethod
    : formProperty(target, 'method')
  const formTarget = button?.hasAttribute('formtarget')
    ? button.formTarget
    : formProperty(target, 'target')
  if (method !== 'post' || !targetsTopPage(formTarget.toLowerCase())) {
    return null
  }
  return button?.hasAttribute('formaction') ? button.formAction : formProperty(target, 'action')
}

function targetsTopPage(formTarget: string): boolean {
  const frame =
    formTarget === '' || formTarget === '_self'
      ? window
      : formTarget === '_parent'
        ? window.parent
        : formTarget === '_top'
          ? window.top
          : null
  return frame !== null && frame === window.top
}

// A field named `action`, `method` or `target` shadows the form's own property; read the getter.
function formProperty(form: HTMLFormElement, name: 'action' | 'method' | 'target'): string {
  const value: unknown = Object.getOwnPropertyDescriptor(
    HTMLFormElement.prototype,
    name
  )?.get?.call(form)
  return typeof value === 'string' ? value : ''
}
