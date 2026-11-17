/**
 * Runs serialized in the page's main world. Electron replaces `window.prompt` with one that throws;
 * an about:blank child frame keeps Chromium's, so the prompt reaches Orca like alert and confirm do.
 */
export function installBrowserWindowPrompt(): void {
  const prompt = (message?: string, defaultValue?: string): string | null => {
    // The HTML namespace keeps this an iframe in SVG and other XML documents too.
    const frame = document.createElementNS('http://www.w3.org/1999/xhtml', 'iframe')
    if (!(frame instanceof HTMLIFrameElement)) {
      return null
    }
    frame.style.display = 'none'
    document.documentElement.append(frame)
    try {
      return frame.contentWindow?.prompt(message, defaultValue) ?? null
    } finally {
      frame.remove()
    }
  }
  try {
    window.prompt = prompt
  } catch {}
}
