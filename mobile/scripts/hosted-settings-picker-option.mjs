import { evaluateHostedDocumentWithRetry } from './hosted-webview-cdp-session.mjs'

export async function waitHostedSettingsPickerOption(document, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const visible = await evaluateHostedDocumentWithRetry(
      document,
      `JSON.stringify(
      Array.from(document.querySelectorAll('body *')).some((element) => {
        if (element.children.length || element.textContent.trim() !== ${JSON.stringify(label)}) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0;
      }))`
    )
    if (JSON.parse(visible)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Settings option did not become visible: ${label}`)
}
