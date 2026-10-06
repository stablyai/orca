/**
 * The 16 px floor for an editable the page styles with CSS rather than with a `TextInput` prop.
 *
 * `mobile-web-app-text-input-font-size-seam.mjs` reads the floor and holds every `TextInput` in a
 * route's closure to it. It cannot see the rich Markdown editor: that surface is a
 * `contenteditable` element in a string of markup, sized by a rule in a stylesheet the same module
 * emits, and the walk there matches JSX `TextInput` tags and `style` props. So the editor shipped
 * at 14 px and was measured at 14 px in both engines — the exact condition the floor exists for,
 * because iOS zooms the page on focus of any editable under 16 px, never zooms back, and
 * `keyboard-occlusion.web.ts` then answers 0 for the rest of the session at a scale other than 1.
 *
 * The rule is over the closure rather than over a list of known editors, for the same reason the
 * `TextInput` one is: the next editable host is the one nobody remembers to add.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { textInputFontSizeFloor } from './mobile-web-app-text-input-font-size-seam.mjs'

/** The seam's export, which is how a size states the floor rather than restating the number. */
const SEAM_EXPORT = 'TEXT_INPUT_FONT_SIZE'

/**
 * Each editable tag in a markup string, whole.
 *
 * The tag is what an editable *is*; its id is optional and is read out of the tag afterwards. A
 * pattern that started from the id matched only the hosts that have one, so a file holding a named
 * host and an anonymous one reported the named host and said nothing about the other.
 */
const EDITABLE_TAG = /<[A-Za-z][^>]*\bcontenteditable="true"[^>]*>/g

/** The id a matched tag carries, or null for one that carries none. */
const TAG_ID = /\bid="([A-Za-z][\w-]*)"/

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Every editable host a closure declares, as `{ file, id }`, one entry per tag.
 *
 * The completeness half of the verdict below: an empty offender list is only evidence when the
 * walk found the editables it is judging. A host with no id lands here with `id: null` and is
 * reported as unresolved rather than passing, and it does so whether or not a named host sits
 * beside it in the same file.
 */
export function editableHostsIn(mobileDir, closure) {
  const found = []
  for (const file of closure.local) {
    const source = readOrNull(join(mobileDir, file))
    if (source === null || !source.includes('contenteditable="true"')) {
      continue
    }
    for (const [tag] of source.matchAll(EDITABLE_TAG)) {
      found.push({ file, id: TAG_ID.exec(tag)?.[1] ?? null })
    }
  }
  return found.sort((left, right) =>
    left.file === right.file
      ? String(left.id).localeCompare(String(right.id))
      : left.file < right.file
        ? -1
        : 1
  )
}

/** The selector as a pattern, with the boundary that keeps `#editor` off `#editor-notes`. */
function selectorPattern(selector) {
  return `${selector.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')}(?![\\w-])`
}

/** The declarations of the rule whose block opens at `open`, or null for one that never closes. */
function blockFrom(source, open) {
  let depth = 1
  for (let at = open; at < source.length; at += 1) {
    if (source[at] === '{') {
      depth += 1
      continue
    }
    if (source[at] === '}') {
      depth -= 1
      if (depth === 0) {
        return source.slice(open, at)
      }
    }
  }
  return null
}

/**
 * Every rule in a stylesheet string whose selector list mentions the selector, in source order.
 *
 * The list runs from a line start, the end of the rule before it, a comma, or the backtick the
 * template literal opens with, up to the `{`; requiring the selector somewhere inside it is what
 * keeps the surrounding TypeScript's own braces out of the walk. Kept as a list rather than
 * collapsed to one selector because a comma binds every selector in it to the same declarations,
 * so the host can be hiding in any of them.
 *
 * Textual, and flat: the sheets this reads have no at-rules and no nesting, which is the same
 * assumption `document-style-scoping.ts` makes and refuses to exceed.
 */
function rulesMentioning(source, selector) {
  const pattern = new RegExp(
    `(?:^|[},\`])([^{};\`]*${selectorPattern(selector)}[^{};\`]*)\\{`,
    'dgm'
  )
  const rules = []
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    // Counted rather than matched to the first `}`: a declaration reading the seam is written
    // `${TEXT_INPUT_FONT_SIZE}px`, whose own closing brace would have ended the block one
    // declaration early and left the size looking absent.
    const declarations = blockFrom(source, match.index + match[0].length)
    if (declarations === null) {
      continue
    }
    const list = match[1]
    rules.push({
      selectors: list
        .split(',')
        .map((one) => one.trim())
        .filter((one) => one !== ''),
      declarations,
      // The selector's own start, not the anchor's: the anchor is the previous rule's `}`, a line up.
      index: match.indices[1][0] + (list.length - list.trimStart().length)
    })
  }
  return rules
}

/** The last compound of a selector — the element the rule is about, not one of its ancestors. */
function subjectCompound(selector) {
  return selector.split(/[\s>+~]+/).at(-1) ?? ''
}

/**
 * The `font-size` the cascade actually uses out of one rule.
 *
 * A rule may declare the property more than once, and CSS takes the last of equal importance, with
 * `!important` outranking every declaration that is not. Reading the first one reported
 * `font-size: 16px; font-size: 14px;` as compliant for a surface the browser renders at 14 px.
 *
 * The flag is stripped from the value it returns, so a compliant size that carries it is read as
 * the size it sets rather than as a shape this walk does not model.
 */
function winningFontSize(declarations) {
  const found = []
  // Split on the separator rather than matching a value pattern: a size read from the seam is
  // written `${TEXT_INPUT_FONT_SIZE}px`, whose own closing brace ends any value pattern that
  // excludes one, and the last declaration in a rule need not carry a trailing semicolon.
  for (const piece of declarations.split(';')) {
    const match = /(?:^|[^\w-])font-size:\s*([\s\S]*)$/.exec(piece)
    if (match === null) {
      continue
    }
    const raw = match[1].trim()
    found.push({
      text: raw.replace(/\s*!\s*important$/i, '').trim(),
      important: /!\s*important$/i.test(raw)
    })
  }
  if (found.length === 0) {
    return null
  }
  return found.findLast((one) => one.important) ?? found.at(-1)
}

/**
 * What the winning `font-size` is worth: a literal, a seam substitution, or something else.
 *
 * Null for a rule that declares no size at all, which is unresolved rather than a pass: the value
 * an editable then takes comes from a rule this walk does not read — the host element's own, or the
 * page's root — so it can be 14 px and the census cannot prove otherwise. Where the `TextInput`
 * half treats an absent prop as inheritance and lets it through, that policy is main's and about a
 * prop; this is CSS, and the inherited value is genuinely out of view.
 */
function readFontSize(mobileDir, source, declarations) {
  const winning = winningFontSize(declarations)
  if (winning === null) {
    return null
  }
  const text = winning.text
  const literal = /^(\d+(?:\.\d+)?)px$/.exec(text)
  if (literal !== null) {
    return { text, onSeam: Number(literal[1]) >= textInputFontSizeFloor(mobileDir) }
  }
  // A substitution, which is only the seam when this module imported the seam's export: the same
  // name declared locally, or imported from somewhere else, is exactly the regression the seam
  // exists to stop wearing its name.
  const substituted = /^\$\{([A-Za-z_$][\w$]*)\}px$/.exec(text)
  if (substituted === null) {
    return { text, onSeam: false }
  }
  const imported = new RegExp(
    `import\\s*\\{[^}]*\\b${SEAM_EXPORT}\\b[^}]*\\}\\s*from\\s*'[^']*text-input-font-size'`
  )
  return { text, onSeam: substituted[1] === SEAM_EXPORT && imported.test(source) }
}

/**
 * Every rule in a sheet that applies exactly this selector, in source order.
 *
 * All of them rather than the first: rules of equal specificity are ranked by source order, so a
 * sheet that declares 16 px and then 14 px renders at 14 px, and reading only the first one called
 * that surface compliant.
 */
function exactRules(source, selector) {
  return rulesMentioning(source, selector).filter((rule) => rule.selectors.includes(selector))
}

/**
 * Every rule in a sheet that sizes the host through a selector this walk cannot rank against the
 * exact one.
 *
 * A subject of higher specificity that still targets the host (`main#editor`, `#editor.x`,
 * `div > #editor`, `#editor:empty`) beats the exact rule, and this census does no specificity
 * arithmetic: such a rule declaring `font-size` makes the host unresolved rather than compliant. A
 * descendant (`#editor p`) is about another element and a pseudo-element (`#editor:empty::before`)
 * is a box the host generates, so neither one is in the way.
 */
function unrankableHostRules(source, selector) {
  return rulesMentioning(source, selector).filter(
    (rule) =>
      winningFontSize(rule.declarations) !== null &&
      rule.selectors.some(
        (one) =>
          one !== selector &&
          !one.includes('::') &&
          new RegExp(selectorPattern(selector)).test(subjectCompound(one))
      )
  )
}

/**
 * Where each editable host's size is declared, as `{ at, size }`.
 *
 * The size is looked for in the same module the markup came from and in the modules directly beside
 * it: a document's markup and its stylesheet are two exports of one program, so the rule is stated
 * over that program's own directory rather than over the whole closure or over its subtree.
 */
function editableHostSizes(mobileDir, closure) {
  const resolutions = []
  for (const host of editableHostsIn(mobileDir, closure)) {
    if (host.id === null) {
      resolutions.push({ at: host.file, size: null })
      continue
    }
    const directory = host.file.slice(0, host.file.lastIndexOf('/'))
    // The immediate directory, not the subtree: the walk stops at the first file whose sheet opens
    // the host's selector, and the closure's order is the bundler's rather than alphabetical, so a
    // sheet one directory down could answer for the sibling the host actually gets.
    const siblings = closure.local.filter(
      (file) => file.slice(0, file.lastIndexOf('/')) === directory
    )
    const selector = `#${host.id}`
    let resolved = null
    for (const file of siblings) {
      const source = readOrNull(join(mobileDir, file))
      if (source === null) {
        continue
      }
      const exact = exactRules(source, selector)
      if (exact.length === 0) {
        continue
      }
      const unrankable = unrankableHostRules(source, selector)
      const named = unrankable[0] ?? exact[0]
      resolved = {
        at: `${file}:${source.slice(0, named.index).split('\n').length}`,
        // Joined in source order because that is the cascade among rules of equal specificity, and
        // `winningFontSize` already reads the last of equal importance out of a declaration string.
        size:
          unrankable.length > 0
            ? null
            : readFontSize(mobileDir, source, exact.map((one) => one.declarations).join(';'))
      }
      break
    }
    resolutions.push(resolved ?? { at: `${host.file} (#${host.id})`, size: null })
  }
  return resolutions
}

/**
 * Every editable host whose size this walk could not follow to a rule, as it names it.
 *
 * A hole rather than a pass: an editable planted with no id, one whose selector no stylesheet
 * beside it opens, or one a higher-specificity rule sizes out of this walk's reach, is a surface
 * the rule cannot judge and has to say so.
 */
export function unresolvedEditableHostStyles(mobileDir, closure) {
  return editableHostSizes(mobileDir, closure)
    .filter((entry) => entry.size === null)
    .map((entry) => entry.at)
    .sort()
}

/** Every editable host in a closure sized below the floor and off the seam, as `path:line`. */
export function editableHostFontSizeOffenders(mobileDir, closure) {
  return [
    ...new Set(
      editableHostSizes(mobileDir, closure)
        .filter((entry) => entry.size !== null && !entry.size.onSeam)
        .map((entry) => entry.at)
    )
  ].sort()
}
