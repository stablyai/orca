import { WebSocket } from 'ws'
import { evaluateHostedDocumentWithRetry } from './hosted-webview-cdp-session.mjs'

export async function dispatchHostedWebViewLongPress(document, label, operations = {}) {
  const evaluate =
    operations.evaluate ??
    ((target, expression) => evaluateHostedDocumentWithRetry(target, expression, WebSocket))
  const wait = operations.wait ?? delay
  const token = `hosted-long-press-${(operations.now ?? Date.now)()}`
  const downValue = await evaluate(
    document,
    `(() => {
      const element = Array.from(document.querySelectorAll('[aria-label]'))
        .find((candidate) => candidate.getAttribute('aria-label') === ${JSON.stringify(label)});
      if (!(element instanceof HTMLElement)) return '';
      document.getSelection()?.removeAllRanges();
      element.setAttribute('data-orca-hosted-long-press', ${JSON.stringify(token)});
      element.dispatchEvent(pointerEvent(element, 'mousedown', 1));
      return ${JSON.stringify(token)};
      function pointerEvent(target, type, buttons) {
        const rect = target.getBoundingClientRect();
        return new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          button: 0,
          buttons,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2
        });
      }
    })()`
  )
  if (downValue !== token) {
    throw new Error(`Hosted WebView control was not found: ${label}`)
  }
  await wait(600)
  await evaluate(
    document,
    `(() => {
      const element = document.querySelector(
        '[data-orca-hosted-long-press=${JSON.stringify(token)}]'
      );
      if (!(element instanceof HTMLElement)) return ${JSON.stringify(token)};
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
        buttons: 0,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      }));
      element.removeAttribute('data-orca-hosted-long-press');
      return ${JSON.stringify(token)};
    })()`
  ).catch(() => {})
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
