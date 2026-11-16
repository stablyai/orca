/**
 * Runs in the Chrome Web Store page's main world: renames the install wording from Chrome to Orca
 * and hides the "Switch to Chrome" banner, which is wrong here because installing works.
 * Self-contained because executeInMainWorld serializes it without its closure. The
 * "Chrome Web Store" name stays.
 */
export function adaptChromeWebStoreWordingForOrca(): void {
  const replacements: [RegExp, string][] = [
    [/\bAdd to Chrome\b/g, 'Add to Orca'],
    [/\bRemove from Chrome\b/g, 'Remove from Orca'],
    [/ has been removed from Chrome\./g, ' has been removed from Orca.']
  ]
  const SWITCH_BANNER_TEXT = 'Switch to Chrome to install extensions and themes'
  const HIDDEN_BANNER_ATTRIBUTE = 'data-orca-hidden-switch-banner'
  const rewrite = (value: string): string =>
    replacements.reduce((text, [pattern, next]) => text.replace(pattern, next), value)
  // Why the climb: the banner's box also holds its "Install Chrome" button, and the store reuses
  // that box for useful notices, so it is hidden only while it carries the switch message.
  const hideSwitchBanner = (text: Node): void => {
    let box = text.parentElement
    while (box && !(box.textContent ?? '').includes('Install Chrome')) {
      box = box.parentElement
    }
    if (box && box !== document.body) {
      box.setAttribute(HIDDEN_BANNER_ATTRIBUTE, '')
      box.style.setProperty('display', 'none', 'important')
    }
  }
  const restoreReusedBanners = (): void => {
    for (const box of document.querySelectorAll<HTMLElement>(`[${HIDDEN_BANNER_ATTRIBUTE}]`)) {
      if (!(box.textContent ?? '').includes(SWITCH_BANNER_TEXT)) {
        box.removeAttribute(HIDDEN_BANNER_ATTRIBUTE)
        box.style.removeProperty('display')
      }
    }
  }
  const relabelText = (node: Node): void => {
    const value = node.nodeValue ?? ''
    if (value.includes(SWITCH_BANNER_TEXT)) {
      hideSwitchBanner(node)
      return
    }
    const next = rewrite(value)
    if (next !== value) {
      node.nodeValue = next
    }
  }
  const relabelElement = (element: Element): void => {
    for (const name of ['aria-label', 'title']) {
      const value = element.getAttribute(name)
      if (value) {
        const next = rewrite(value)
        if (next !== value) {
          element.setAttribute(name, next)
        }
      }
    }
  }
  const relabelTree = (root: Node): void => {
    if (root.nodeType === Node.TEXT_NODE) {
      relabelText(root)
      return
    }
    if (!(root instanceof Element) && root !== document) {
      return
    }
    if (root instanceof Element) {
      relabelElement(root)
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) {
        relabelText(node)
      } else if (node instanceof Element) {
        relabelElement(node)
      }
    }
  }
  // Why observe: the store is a single-page app that redraws its install button on every state change.
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') {
        relabelText(record.target)
      } else if (record.type === 'attributes' && record.target instanceof Element) {
        relabelElement(record.target)
      } else {
        record.addedNodes.forEach(relabelTree)
      }
    }
    restoreReusedBanners()
  }).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-label', 'title']
  })
  relabelTree(document)
}
