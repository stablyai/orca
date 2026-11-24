// Scope guest document CSS to its host so it cannot restyle the app after unmount.
// Prefixing preserves document.getElementById and xterm CSS, which a shadow root would break.
// Accept only flat sheets; terminals drop document rules, while editors move those rules onto their host.

type StyleRule = { selectors: string; declarations: string }

function stripComments(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, '')
}

function parseStyleRules(css: string): StyleRule[] {
  const rules: StyleRule[] = []
  let at = 0
  while (at < css.length) {
    const open = css.indexOf('{', at)
    if (open === -1) {
      break
    }
    const close = css.indexOf('}', open)
    if (close === -1) {
      throw new Error('the stylesheet has a rule that never closes')
    }
    const selectors = stripComments(css.slice(at, open)).trim()
    if (selectors.includes('@')) {
      throw new Error(`at-rules cannot be scoped to a host: ${selectors}`)
    }
    if (selectors.length === 0) {
      throw new Error('the stylesheet has a declaration block with no selector')
    }
    rules.push({ selectors, declarations: css.slice(open, close + 1) })
    at = close + 1
  }
  return rules
}

function leadingElement(selector: string): string {
  return selector.trim().split(/[\s>+~:.[#]/)[0] ?? ''
}

// Document-wide rules would change the app’s background, overflow and box model beyond this page.
export function isDocumentLevelSelector(selectors: string): boolean {
  return selectors.split(',').some((one) => ['*', 'html', 'body'].includes(leadingElement(one)))
}

export function documentLevelRules(css: string): string[] {
  return parseStyleRules(css)
    .filter((rule) => isDocumentLevelSelector(rule.selectors))
    .map((rule) => rule.selectors)
}

// Drop document rules rather than prefixing them; the terminal host gets its surface through the platform seam.
export function scopeStyleToHost(css: string, prefix: string): string {
  return parseStyleRules(css)
    .filter((rule) => !isDocumentLevelSelector(rule.selectors))
    .map((rule) => {
      const scoped = rule.selectors
        .split(',')
        .map((one) => `${prefix} ${one.trim()}`)
        .join(',\n')
      return `${scoped} ${rule.declarations}`
    })
    .join('\n')
}

const DOCUMENT_ROOT_SELECTORS = ['html', 'body', ':root']

// leadingElement splits on colons; explicitly detect :root descendants or they would silently match nothing.
function startsAtDocumentRoot(selector: string): boolean {
  return (
    DOCUMENT_ROOT_SELECTORS.includes(leadingElement(selector)) || /^:root(?![\w-])/.test(selector)
  )
}

// Universal rules include the host’s own box model; document names become the host.
// Reject descendants like body p: prefixing matches nothing, while stripping body silently changes semantics.
function hostSelectors(selector: string, prefix: string): string[] {
  const one = selector.trim()
  if (one === '*') {
    return [prefix, `${prefix} *`]
  }
  if (DOCUMENT_ROOT_SELECTORS.includes(one)) {
    return [prefix]
  }
  if (startsAtDocumentRoot(one)) {
    throw new Error(`a selector under the document cannot be moved onto a host: ${one}`)
  }
  return [`${prefix} ${one}`]
}

// Editors retain document rules on their host; dedupe selectors such as html, body after mapping.
export function scopeDocumentStyleToHost(css: string, prefix: string): string {
  return parseStyleRules(css)
    .map((rule) => {
      const scoped = [
        ...new Set(rule.selectors.split(',').flatMap((one) => hostSelectors(one, prefix)))
      ].join(',\n')
      return `${scoped} ${rule.declarations}`
    })
    .join('\n')
}
