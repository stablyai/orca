// Census CSS-sized contenteditable markup invisible to JSX TextInput rule; editor once shipped at 14px.
// Any editable under floor focus-zooms iOS page and disables keyboard-occlusion at non-1 scale; scan whole closure for future hosts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { textInputFontSizeFloor } from './mobile-web-app-text-input-font-size-seam.mjs'

const SEAM_EXPORT = 'TEXT_INPUT_FONT_SIZE'

// Match editable tag before optional ID; id-first scan missed anonymous host beside named one.
const EDITABLE_TAG = /<[A-Za-z][^>]*\bcontenteditable="true"[^>]*>/g

const TAG_ID = /\bid="([A-Za-z][\w-]*)"/

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// Require complete host census before interpreting zero offenders; anonymous id:null hosts are unresolved, never silently clean.
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

// Require ID boundary so #editor cannot match #editor-notes.
function selectorPattern(selector) {
  return `${selector.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')}(?![\\w-])`
}

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

// Read whole selector lists so every comma target shares declarations; anchors exclude surrounding TS braces.
// Support flat CSS only, without at-rules/nesting, matching document-style-scoping constraints.
function rulesMentioning(source, selector) {
  const pattern = new RegExp(
    `(?:^|[},\`])([^{};\`]*${selectorPattern(selector)}[^{};\`]*)\\{`,
    'dgm'
  )
  const rules = []
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    // Count braces: template ${TEXT_INPUT_FONT_SIZE}px contains } before CSS block ends.
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
      // Report selector’s start, not previous-rule anchor’s line.
      index: match.indices[1][0] + (list.length - list.trimStart().length)
    })
  }
  return rules
}

function subjectCompound(selector) {
  return selector.split(/[\s>+~]+/).at(-1) ?? ''
}

// CSS cascade takes last equal-importance font-size; important beats ordinary. Strip flag before reading value or valid seam sizes appear unknown.
function winningFontSize(declarations) {
  const found = []
  // Split declarations, not }-excluding patterns: seam substitution contains brace and final declaration may omit semicolon.
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

// Missing CSS size is unresolved: inherited value lies outside modeled rules. TextInput’s absent-prop inheritance policy does not prove CSS host safe.
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
  // Recognize substitution only through imported seam binding; local/same-spelled unrelated value must not pass.
  const substituted = /^\$\{([A-Za-z_$][\w$]*)\}px$/.exec(text)
  if (substituted === null) {
    return { text, onSeam: false }
  }
  const imported = new RegExp(
    `import\\s*\\{[^}]*\\b${SEAM_EXPORT}\\b[^}]*\\}\\s*from\\s*'[^']*text-input-font-size'`
  )
  return { text, onSeam: substituted[1] === SEAM_EXPORT && imported.test(source) }
}

// Read all exact-selector rules in source order; first-safe rule can be overridden by later unsafe size.
function exactRules(source, selector) {
  return rulesMentioning(source, selector).filter((rule) => rule.selectors.includes(selector))
}

// More-specific host selectors make size unresolved because census cannot rank specificity.
// Descendants/pseudo-elements target other boxes and must not invalidate host’s exact rule.
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

// Search markup module and immediate siblings for host CSS: they form one document program; unrelated subtree/closure sheets cannot answer for it.
function editableHostSizes(mobileDir, closure) {
  const resolutions = []
  for (const host of editableHostsIn(mobileDir, closure)) {
    if (host.id === null) {
      resolutions.push({ at: host.file, size: null })
      continue
    }
    const directory = host.file.slice(0, host.file.lastIndexOf('/'))
    // Immediate directory only: bundler closure order could otherwise select nested sheet before actual sibling stylesheet.
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
        // Preserve source-order cascade; winningFontSize handles repeated declarations/importance within each rule.
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

// Report no-ID, missing-selector and unrankable-specificity hosts as unresolved; unknown size must never pass as compliant.
export function unresolvedEditableHostStyles(mobileDir, closure) {
  return editableHostSizes(mobileDir, closure)
    .filter((entry) => entry.size === null)
    .map((entry) => entry.at)
    .sort()
}

export function editableHostFontSizeOffenders(mobileDir, closure) {
  return [
    ...new Set(
      editableHostSizes(mobileDir, closure)
        .filter((entry) => entry.size !== null && !entry.size.onSeam)
        .map((entry) => entry.at)
    )
  ].sort()
}
