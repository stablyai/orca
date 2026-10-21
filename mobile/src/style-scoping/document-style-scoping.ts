/**
 * A document's own rules, rewritten to reach only what the host element contains.
 *
 * Inside the WebView the document owns its page, so its stylesheet says `*`, `html` and `body`
 * and means it. On the page the document is a guest: the same sheet, appended to the head of a
 * React Native Web application, restyles every screen the shell can show and keeps doing it after
 * the terminal is gone. Ruling 19's shape applies to CSS as it does to `window.onerror` — the
 * page mount may style only what it owns — so the document-level rules are dropped and every
 * remaining selector is held under the host's own class.
 *
 * A prefix rather than a shadow root: the document reads its elements by id through
 * `document.getElementById`, which does not cross a shadow boundary, and xterm's own sheet is
 * written against `.xterm` in the same document. Both would need a different program.
 *
 * The rewrite is textual because the input is: flat stylesheets this repository writes or
 * generates, with no at-rules and no nesting. Anything else throws rather than passing a rule
 * through unscoped, and `document-style-scoping.test.ts` holds that.
 *
 * Two page mounts use it and they want opposite things from the document's own rules, which is why
 * there are two exports rather than a flag. The terminal drops them, because the colour `html, body`
 * was setting belongs to the application and a seam repaints the host instead. The rich Markdown
 * editor moves them onto the host, because the host element *is* that editor's page: its variables,
 * its surface colour and its font are what every other rule in the sheet reads.
 */

/** A rule's selector list and its declaration block, as the source text writes them. */
type StyleRule = { selectors: string; declarations: string }

function stripComments(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, '')
}

/** The sheet as a flat list of rules; comments and whitespace between them are dropped. */
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

/** The element a selector starts from, or the empty string when it starts from a class or an id. */
function leadingElement(selector: string): string {
  return selector.trim().split(/[\s>+~:.[#]/)[0] ?? ''
}

/**
 * Whether a selector addresses the document itself rather than something inside it.
 *
 * These are the rules a page must not carry: one that kept them would set the application's own
 * background and overflow, and every element's box model, for as long as the sheet is in the head.
 */
export function isDocumentLevelSelector(selectors: string): boolean {
  return selectors.split(',').some((one) => ['*', 'html', 'body'].includes(leadingElement(one)))
}

/** The rules a page may not inject, as one line each. Exported so a test can name them. */
export function documentLevelRules(css: string): string[] {
  return parseStyleRules(css)
    .filter((rule) => isDocumentLevelSelector(rule.selectors))
    .map((rule) => rule.selectors)
}

/**
 * The same stylesheet with every selector held under `prefix`.
 *
 * A rule that addresses the document itself is dropped rather than prefixed: `.host *` is not
 * what `*` meant, and the page has no use for either reading.
 */
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

/** The three names a document uses for itself, all of which the host element answers to. */
const DOCUMENT_ROOT_SELECTORS = ['html', 'body', ':root']

/**
 * Whether a selector starts at the document rather than being one of its names.
 *
 * `leadingElement` splits on `:`, so it answers the empty string for anything beginning `:root` and
 * the check below would have let `:root .foo` through to `${prefix} :root .foo` — a rule that
 * matches nothing, silently. `html` and `body` are read the way they always were.
 */
function startsAtDocumentRoot(selector: string): boolean {
  return (
    DOCUMENT_ROOT_SELECTORS.includes(leadingElement(selector)) || /^:root(?![\w-])/.test(selector)
  )
}

/**
 * One selector as the host's subtree spells it.
 *
 * `*` becomes the host and everything in it, because that is what the document meant by it — the
 * box model it sets has to reach the element the padding is on. A name for the document itself
 * becomes the host. Anything else hangs under the host.
 *
 * A selector that only *starts* at the document (`body p`) throws: `${prefix} body p` matches
 * nothing and `${prefix} p` is not what it said, so either rewrite would change the sheet in
 * silence.
 */
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

/**
 * The same stylesheet with the whole document held under `prefix`, its own rules included.
 *
 * The counterpart of `scopeStyleToHost` for a document whose host element is the page it thought
 * it had. Duplicates are collapsed, so `html, body { … }` is one rule on one selector rather than
 * the same selector written twice.
 */
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
