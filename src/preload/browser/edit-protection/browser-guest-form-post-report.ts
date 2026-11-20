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
  // Fires only for a submission that wasn't cancelled; main matches it to the navigation it starts.
  window.addEventListener(
    'formdata',
    (event) => {
      const formPost = event.isTrusted ? postedFormAction(event.target, lastSubmitByForm) : null
      if (formPost) {
        port.send(BROWSER_GUEST_PROTECTION_REPORT, { formPost })
      }
    },
    true
  )
  // Form events stay inside a shadow root; the top page's own navigation still carries the POST
  // body. Only the top frame listens: an embedded frame's navigation doesn't replace the page.
  if (window !== window.top) {
    return
  }
  window.navigation?.addEventListener('navigate', (event) => {
    if (event.isTrusted && event.formData && !event.hashChange) {
      port.send(BROWSER_GUEST_PROTECTION_REPORT, { formPost: event.destination.url })
    }
  })
}

/** The action URL of a POST that replaces the top page; null for GET or another target. */
function postedFormAction(
  target: EventTarget | null,
  lastSubmitByForm: WeakMap<HTMLFormElement, SubmitEvent>
): string | null {
  // `new FormData(form)` fires formdata too. A submission builds its entry list only after its
  // submit event finished dispatching uncancelled; a page handler's FormData runs during it.
  // (`form.submit()` fires no submit event; in the top frame the Navigation API still sees it.)
  const submit = target instanceof HTMLFormElement ? lastSubmitByForm.get(target) : undefined
  if (
    !(target instanceof HTMLFormElement) ||
    !submit ||
    submit.eventPhase !== Event.NONE ||
    submit.defaultPrevented
  ) {
    return null
  }
  lastSubmitByForm.delete(target)
  const submitter = submit.submitter
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
