import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import * as esbuild from 'esbuild'
import { importTypeScriptModule } from './import-typescript-module.mjs'
import {
  TERMINAL_DOCUMENT_HOST_SEAMS_MODULE,
  TERMINAL_DOCUMENT_MODULE_ORDER,
  TERMINAL_DOCUMENT_RESET_CALL,
  TERMINAL_DOCUMENT_SCOPE_MODULE,
  terminalDocumentStartFunctionName,
  terminalDocumentStopFunctionName
} from './terminal-document-module-order.mjs'

/**
 * Turns one module of the in-WebView terminal document back into the script text the document
 * carries.
 *
 * The document is a string the native WebView loads, so its parts cannot be imported by anything;
 * the web page needs exactly those parts and must not re-implement them. So the parts are modules,
 * and this is the other direction: the modules' declarations, with their imports removed and their
 * exports unmarked, spliced into the one function scope the document has always been.
 *
 * Imports are dropped rather than resolved because inside the document every name is already in
 * scope — that is what the single IIFE means. `document-externals.ts` declares the names that have
 * not moved into modules yet, and it emits nothing at all.
 *
 * `esbuild` does the TypeScript, as it already does for the xterm engine beside this file. It is a
 * transform and not a bundle: a bundler would order the output by its dependency graph, and the
 * document's order is part of what the equivalence test holds fixed.
 */
const INDENT = '  '

const constantsPath = path.join(
  import.meta.dirname,
  '..',
  'src',
  'terminal',
  'document',
  'document-constants.ts'
)

let substitutions = null

/**
 * `document-constants.ts` as the literal text each name stands for.
 *
 * Substitution happens after the import lines are dropped, when the names are free again, and it is
 * textual rather than an esbuild `define` because a `define` whose value is an object or an array
 * is injected as a helper binding instead of being inlined, which is not what the document carries.
 * The names are exported for this purpose only and none of them appears inside a string.
 */
async function documentConstantSubstitutions() {
  if (substitutions === null) {
    const module = await importTypeScriptModule(constantsPath)
    substitutions = Object.fromEntries(
      Object.entries(module).map(([name, value]) => [name, JSON.stringify(value)])
    )
  }
  return substitutions
}

/**
 * Replaces each constant's name with its literal.
 *
 * The replacement is a function, not the literal itself: as a string, `$&`, `` $` ``, `$'` and
 * `$n` are replacement patterns, so a constant whose value contains one would be spliced with the
 * match rather than written out. A function replacer has no such reading.
 */
export function substituteDocumentConstants(text, substitutions) {
  let substituted = text
  for (const [name, literal] of Object.entries(substitutions)) {
    substituted = substituted.replaceAll(new RegExp(`\\b${name}\\b`, 'g'), () => literal)
  }
  return substituted
}

/**
 * Whether a line is a lint directive.
 *
 * These are removed before the transform, not after it: a directive inside an expression makes
 * esbuild wrap that expression in parentheses to keep the comment where it was, and those
 * parentheses are tokens the document does not have. They are tooling metadata about the source,
 * not part of the program the WebView runs.
 */
function isLintDirectiveLine(line) {
  return /^\s*\/\/\s*oxlint-disable/.test(line)
}

/** Whether a line opens an import the document does not need. */
function isImportLine(line) {
  return /^import[\s{'"]/.test(line)
}

/** Whether a statement that started on this line also ended on it. */
function closesOnSameLine(line, closer) {
  return line.includes(closer)
}

/**
 * The emitted text of one module: transpiled, unexported, un-imported and indented into the IIFE.
 *
 * Multi-line imports are handled by dropping through to the line that closes them, which esbuild's
 * output makes safe: it prints one import per line.
 */
export async function emitTerminalDocumentModule(modulePath) {
  const source = await readFile(modulePath, 'utf8')
  const program = source
    .split('\n')
    .filter((line) => !isLintDirectiveLine(line))
    .join('\n')
  const { code } = await esbuild.transform(program, {
    loader: 'ts',
    format: 'esm',
    target: 'chrome74',
    // The document is read by people as well as by a WebView, and the equivalence test compares
    // tokens, so keeping the printer's own layout costs nothing and keeps the diff legible.
    minify: false
  })
  const kept = []
  // esbuild wraps a long import or export list across lines, so both are skipped to their closer
  // rather than by their first line. An export list dropped by its keyword alone would leave a
  // bare block statement in the document, and an import list would leave its names loose.
  let skipUntil = null
  for (const line of code.split('\n')) {
    if (skipUntil !== null) {
      if (closesOnSameLine(line, skipUntil)) {
        skipUntil = null
      }
      continue
    }
    if (isImportLine(line)) {
      skipUntil = closesOnSameLine(line, ' from ') || closesOnSameLine(line, ';') ? null : ' from '
      continue
    }
    if (line.startsWith('export {')) {
      skipUntil = closesOnSameLine(line, '}') ? null : '}'
      continue
    }
    kept.push(line.startsWith('export ') ? line.slice('export '.length) : line)
  }
  const text = substituteDocumentConstants(kept.join('\n'), await documentConstantSubstitutions())
  const substituted = await esbuild.transform(text, {
    loader: 'js',
    format: 'esm',
    target: 'chrome74',
    minify: false
  })
  const body = substituted.code.trim()
  return body
    .split('\n')
    .map((line) => (line.length === 0 ? line : `${INDENT}${line}`))
    .join('\n')
}

const documentDirectory = path.join(import.meta.dirname, '..', 'src', 'terminal', 'document')

export const TERMINAL_DOCUMENT_SCRIPT_PATH = path.join(
  import.meta.dirname,
  '..',
  'src',
  'terminal',
  'terminal-webview-document-script.generated.ts'
)

/**
 * The start functions the emitted document calls, in module order (ruling 20).
 *
 * Presence is read from the source rather than listed here: a module that has no top-level effect
 * exports no start function, and one that grows an effect is reached the moment it does. The
 * declaration is matched on its own line because that is how esbuild's TypeScript prints it and
 * how every module in this directory writes it.
 */
export async function terminalDocumentStartCalls(moduleNames) {
  return await declaredFunctions(moduleNames, terminalDocumentStartFunctionName)
}

/** The stop functions, in module order. The page runs them in reverse; the WebView never stops. */
export async function terminalDocumentStopCalls(moduleNames) {
  return await declaredFunctions(moduleNames, terminalDocumentStopFunctionName)
}

async function declaredFunctions(moduleNames, nameFor) {
  const found = []
  for (const name of moduleNames) {
    const source = await readFile(path.join(documentDirectory, `${name}.ts`), 'utf8')
    const declared = nameFor(name)
    if (new RegExp(`^export function ${declared}\\(\\) \\{$`, 'm').test(source)) {
      found.push(declared)
    }
  }
  return found
}

/**
 * The document's whole script: every module in the order the document had, inside the one function
 * scope it has always been, and then the one call sequence that starts them.
 */
export async function buildTerminalDocumentScript() {
  const emitted = []
  // The scope object goes first: every module below reads it, and the document is one function
  // scope, so it has to exist before any of them run. It is the only part of the emitted script
  // the hand-written document did not have, and the host seams come ahead of it because its
  // defaults are those six functions.
  const order = [
    TERMINAL_DOCUMENT_HOST_SEAMS_MODULE,
    TERMINAL_DOCUMENT_SCOPE_MODULE,
    ...TERMINAL_DOCUMENT_MODULE_ORDER
  ]
  for (const name of order) {
    emitted.push(await emitTerminalDocumentModule(path.join(documentDirectory, `${name}.ts`)))
  }
  // Rulings 20 and 21: the modules above only declare. The scope's reset comes first, so the
  // state every module reads is the state a fresh parse has; then every element read, listener
  // and reporter install runs, once here and per mount on the page, in the order both hosts share.
  const calls = [TERMINAL_DOCUMENT_RESET_CALL, ...(await terminalDocumentStartCalls(order))].map(
    (name) => `${INDENT}${name}();`
  )
  return `(function() {\n${emitted.join('\n')}\n${calls.join('\n')}\n})();`
}

async function main() {
  const script = await buildTerminalDocumentScript()
  await writeFile(
    TERMINAL_DOCUMENT_SCRIPT_PATH,
    `// Generated by scripts/build-terminal-document-script.mjs. Do not edit.\n` +
      `// The source is mobile/src/terminal/document/, in the order\n` +
      `// scripts/terminal-document-module-order.mjs pins.\n` +
      `export const TERMINAL_DOCUMENT_SCRIPT = ${JSON.stringify(script)}\n`
  )
}

if (process.argv[1] === import.meta.filename) {
  await main()
}
