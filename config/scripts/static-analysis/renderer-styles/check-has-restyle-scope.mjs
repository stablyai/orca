// Rejects `:has()` rules that make Blink restyle the anchor's whole subtree on any mutation
// (#34312). Checks Tailwind's compiled output plus plain and listed package stylesheets.
// Not covered: `?inline` imports, template-literal imports, `.js` files, relative node_modules paths.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const TAILWIND_ENTRY = 'src/renderer/src/assets/main.css'
// Plain pathspec `*` also matches `/`; files main.css imports are rescanned harmlessly.
const PLAIN_CSS = ['src/renderer/*.css', 'src/shared/*.css']
// Package stylesheets imported from renderer JS (xterm is also compiled in through main.css).
const VENDOR_CSS = [
  '@xterm/xterm/css/xterm.css',
  'monaco-editor/min/vs/editor/editor.main.css',
  'pdfjs-dist/web/pdf_viewer.css',
  'react-grab/styles.css'
]
// Accepted vendor findings. pdf.js's sheet stays loaded once the lazy ImageViewer first opens, but
// these anchor on viewer-only widgets: the #34312 harness showed no subtree restyle and the same
// cost as with every pdf.js :has() rule removed. A vendor bump that adds a finding fails here.
const VENDOR_BASELINE = new Set([
  'pdfjs-dist/web/pdf_viewer.css: .annotationLayer .buttonWidgetAnnotation:is(.checkBox, .radioButton):has([data-canvas-name="checked"]) input:checked',
  'pdfjs-dist/web/pdf_viewer.css: .annotationLayer .buttonWidgetAnnotation:is(.checkBox, .radioButton):has([data-canvas-name="unchecked"]) input:not(:checked)',
  'pdfjs-dist/web/pdf_viewer.css: #addSignatureDialog .mainContainer #addSignatureActionContainer #addSignatureControls #horizontalContainer #addSignatureDescriptionContainer:has(input:disabled) > label'
])
const CSS_IMPORT =
  /(?:\bimport\s*(?:[\w*{}\s,]+?\bfrom\s*)?\(?|@import\s+(?:url\()?)\s*(?:['"]([^'"]+\.css)['"]|([^'"()\s]+\.css)\s*\))/g
const IMPORT_SCAN = ['src/renderer/*.ts', 'src/renderer/*.tsx', ...PLAIN_CSS]
const LS_FILES = ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--']
const GREP_CSS = ['grep', '-lz', '--untracked', '-F', '.css', '--']
// Whole-line comments only: stripping mid-line `//` would eat imports after a URL string.
const COMMENT = /^\s*\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm
const SPECIFIC = new Set(['class', 'id', 'attribute'])
const SIBLING = new Set(['next-sibling', 'later-sibling'])

// Tailwind's own packages, resolved through the direct @tailwindcss/vite dependency.
function loadToolchain(root) {
  const fromVite = createRequire(
    createRequire(path.join(root, 'package.json')).resolve('@tailwindcss/vite')
  )
  const nodePath = fromVite.resolve('@tailwindcss/node')
  return {
    tailwind: fromVite(nodePath),
    oxide: fromVite('@tailwindcss/oxide'),
    lightningcss: createRequire(nodePath)('lightningcss')
  }
}

function compounds(selector) {
  const result = [[]]
  for (const component of selector) {
    if (component.type === 'combinator') {
      result.push([])
    } else {
      result.at(-1).push(component)
    }
  }
  return result.filter((compound) => compound.length > 0)
}

// Blink's descendant invalidation set keys on the subject's class/id/attribute; without one it is the whole subtree.
function isBroad(compound) {
  return !compound.some(
    (component) =>
      SPECIFIC.has(component.type) ||
      (['is', 'where'].includes(component.kind) &&
        component.selectors.every((branch) => !isBroad(compounds(branch).at(-1) ?? [])))
  )
}

// Only `:has(+ x)` / `:has(~ x)` (a leading :scope) stay among siblings; `:has(.a + .b)` starts with a descendant.
function isSiblingOnly(relativeSelectors) {
  return relativeSelectors.every(
    ([first, ...rest]) =>
      first?.type === 'pseudo-class' &&
      first.kind === 'scope' &&
      rest.every((component) => component.type !== 'combinator' || SIBLING.has(component.value))
  )
}

// `outerSubject` is the rule's final subject when this selector sits inside a non-subject compound, else null.
function visitSelector(selector, outerSubject, report) {
  const parts = compounds(selector)
  parts.forEach((compound, index) => {
    const subject = index === parts.length - 1 ? outerSubject : (outerSubject ?? parts.at(-1))
    for (const component of compound) {
      // `:host(<selector>)` holds one selector, not a list, and is outside the light DOM.
      if (component.type !== 'pseudo-class' || component.kind === 'host') {
        continue
      }
      if (component.kind === 'has') {
        if (subject && isBroad(subject) && !isSiblingOnly(component.selectors)) {
          report()
        }
        component.selectors.forEach((nested) => visitSelector(nested, null, report))
        continue
      }
      // :is()/:where()/:not()/:nth-child(of) arguments match this same element, so they keep its context.
      for (const nested of [...(component.selectors ?? []), ...(component.of ?? [])]) {
        visitSelector(nested, subject, report)
      }
    }
  })
}

// Top-level commas only; escapes and brackets in Tailwind class names stay intact.
function splitSelectorList(text) {
  const parts = ['']
  let depth = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '\\') {
      parts[parts.length - 1] += text.slice(index, index + 2)
      index++
      continue
    }
    depth += '(['.includes(char) ? 1 : ')]'.includes(char) ? -1 : 0
    if (char === ',' && depth === 0) {
      parts.push('')
    } else {
      parts[parts.length - 1] += char
    }
  }
  return parts.map((part) => part.trim().replace(/\s+/g, ' '))
}

/** Selectors whose non-subject `:has()` invalidates a whole subtree; nesting is lowered first. */
export function findHasRestyleProblems(css, { lightningcss } = loadToolchain(process.cwd())) {
  const lowered = lightningcss.transform({
    filename: 'input.css',
    code: Buffer.from(css),
    include: lightningcss.Features.Nesting,
    errorRecovery: true
  })
  const problems = new Set()
  const flat = lowered.code.toString()
  const lines = flat.split('\n')
  lightningcss.transform({
    filename: 'flat.css',
    code: Buffer.from(flat),
    errorRecovery: true,
    visitor: {
      Rule: {
        style(rule) {
          rule.value.selectors.forEach((selector, index) =>
            visitSelector(selector, null, () => {
              // Selector text only for findings: slicing the sheet per rule dominated the runtime.
              const { line, column } = rule.value.loc
              const tail = lines.slice(line).join('\n')
              const texts = splitSelectorList(tail.slice(column - 1, tail.indexOf('{', column - 1)))
              problems.add(texts[index] ?? texts.join(', '))
            })
          )
        }
      }
    }
  })
  return [...problems]
}

/** Tailwind's build of `css` as Vite would emit it, scanning `scanBase` for candidates. */
export async function compileTailwind(
  css,
  { base, scanBase, toolchain = loadToolchain(process.cwd()) }
) {
  const { tailwind, oxide } = toolchain
  const compiler = await tailwind.compile(css, { base, onDependency() {} })
  // A null root means auto-detection from `scanBase`; `source(none)` turns scanning off.
  const autoSource = { base: scanBase, pattern: '**/*', ...compiler.root, negated: false }
  const detected = compiler.root === 'none' ? [] : [autoSource]
  const scanner = new oxide.Scanner({ sources: [...detected, ...compiler.sources] })
  return compiler.build(scanner.scan())
}

// Tracked plus untracked-but-not-ignored paths, so local work is checked before it is staged.
function gitPaths(root, args) {
  return execFileSync('git', ['-c', 'submodule.recurse=false', ...args], {
    cwd: root,
    encoding: 'utf8'
  })
    .split('\0')
    .filter((file) => file && file !== TAILWIND_ENTRY && existsSync(path.join(root, file)))
}

// Package CSS that renderer TS/TSX imports or a plain stylesheet @imports; main.css compiles its own.
function unlistedVendorImports(root) {
  const specifiers = new Set()
  // git grep prefilters ~13k renderer files; reading each one dominated the runtime.
  for (const file of gitPaths(root, [...GREP_CSS, ...IMPORT_SCAN])) {
    const source = readFileSync(path.join(root, file), 'utf8').replace(COMMENT, '')
    for (const [, quoted, unquoted] of source.matchAll(CSS_IMPORT)) {
      specifiers.add(quoted ?? unquoted)
    }
  }
  return [...specifiers]
    .filter((specifier) => !/^(?:\.|\/|@\/)/.test(specifier) && !VENDOR_CSS.includes(specifier))
    .sort()
}

export async function main(root = process.cwd()) {
  const toolchain = loadToolchain(root)
  const unlisted = unlistedVendorImports(root)
  if (unlisted.length > 0) {
    console.error(`Add renderer-imported stylesheets to VENDOR_CSS: ${unlisted.join(', ')}`)
    return 1
  }
  const resolveVendor = createRequire(path.join(root, 'src/renderer/src/main.tsx')).resolve
  const entry = path.join(root, TAILWIND_ENTRY)
  const sources = [
    {
      name: `${TAILWIND_ENTRY} (compiled)`,
      css: await compileTailwind(readFileSync(entry, 'utf8'), {
        base: path.dirname(entry),
        scanBase: path.join(root, 'src/renderer'),
        toolchain
      })
    },
    ...gitPaths(root, [...LS_FILES, ...PLAIN_CSS]).map((file) => ({
      name: file,
      css: readFileSync(path.join(root, file), 'utf8')
    })),
    ...VENDOR_CSS.map((specifier) => ({
      name: specifier,
      css: readFileSync(resolveVendor(specifier), 'utf8')
    }))
  ]
  const all = sources.flatMap(({ name, css }) =>
    findHasRestyleProblems(css, toolchain).map((selector) => `${name}: ${selector}`)
  )
  const stale = [...VENDOR_BASELINE].filter((entry) => !all.includes(entry))
  if (stale.length > 0) {
    console.error(`Remove stale VENDOR_BASELINE entries:\n- ${stale.join('\n- ')}`)
    return 1
  }
  const findings = all.filter((finding) => !VENDOR_BASELINE.has(finding))
  if (findings.length > 0) {
    console.error(`:has() restyle-scope check failed with ${findings.length} finding(s):`)
    for (const finding of findings) {
      console.error(`- ${finding}`)
    }
    console.error(
      'A :has() followed by a combinator into a subject with no class, id or attribute makes ' +
        'Blink restyle the whole subtree on any mutation (#34312). Give the subject a class, e.g. ' +
        "[[class~='group/x']:has(…)_&]:… instead of group-has-*."
    )
    return 1
  }
  console.log(`:has() restyle-scope check passed (${sources.length} stylesheets).`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // An uninstalled VENDOR_CSS package surfaces as Node's "Cannot find module" message.
  process.exit(await main().catch((error) => (console.error(error.message), 1)))
}
