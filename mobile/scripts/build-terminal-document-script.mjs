import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import * as esbuild from 'esbuild'
import { importTypeScriptModule } from './import-typescript-module.mjs'
import {
  TERMINAL_DOCUMENT_HOST_SEAMS_MODULE,
  TERMINAL_DOCUMENT_MODULE_ORDER,
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

const GENERATED_HEADER =
  `// Generated by scripts/build-terminal-document-script.mjs. Do not edit.\n` +
  `// The source is mobile/src/terminal/document/, in the order\n` +
  `// scripts/terminal-document-module-order.mjs pins.`

export const TERMINAL_DOCUMENT_FACTORY_MODULE_PATH = path.join(
  import.meta.dirname,
  '..',
  'src',
  'terminal',
  'terminal-webview-document-factory.generated.ts'
)

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

/** The name the emitted factory is declared under, and the one the native document calls. */
export const TERMINAL_DOCUMENT_FACTORY_NAME = 'createTerminalDocument'

/** The name the factory's host argument is bound to, which is the scope's only input. */
const HOST_PARAMETER = 'host'

/**
 * The emitted scope construction, which is the one line the host argument reaches.
 *
 * The module declares `scope` for its own consumers, who have no host to pass; the document has
 * one, and it is the factory's parameter. So the emitted declaration is rewritten rather than
 * written twice, and the rewrite refuses if the line it expects is not there — a rename that
 * silently dropped the host would give every call the window defaults.
 */
export function bindScopeToHost(text) {
  const declaration = 'const scope = createTerminalDocumentScope();'
  const occurrences = text.split(declaration).length - 1
  if (occurrences !== 1) {
    throw new Error(
      `expected exactly one \`${declaration}\` in the emitted scope module, found ${String(occurrences)}`
    )
  }
  return text.replace(declaration, `const scope = createTerminalDocumentScope(${HOST_PARAMETER});`)
}

/**
 * One module's text exactly as the emitted document carries it.
 *
 * The scope module is the only one the document rewrites, so a reader that compared a raw emit
 * against the document would miss by that one line. Exported so every reader applies the same
 * rewrite rather than restating it and agreeing with a document that was built differently.
 */
export async function emitDocumentedTerminalModule(moduleName) {
  const text = await emitTerminalDocumentModule(path.join(documentDirectory, `${moduleName}.ts`))
  return moduleName === TERMINAL_DOCUMENT_SCOPE_MODULE ? bindScopeToHost(text) : text
}

/**
 * The factory's body: every module in the order the document had, the call sequence that starts
 * them, the handle that stops them again, and the return. Shared by both artifacts (ruling 23).
 *
 * Ruling 22. The concatenation already gave the modules one function scope with one local `scope`;
 * naming that scope a function is what makes it the shape both hosts run. Every call gets its own
 * state by construction, so the page needs no module singleton, no reset between mounts and no
 * claim on the page — a second terminal is a second call. The native document is this function and
 * one call with no argument, which is what it has always been.
 */
export async function buildTerminalDocumentFactoryBody() {
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
    emitted.push(await emitDocumentedTerminalModule(name))
  }
  // Ruling 21's cancellation, in reverse module order: a stop undoes what its own start did, and
  // the frames the document is still owed go last because the stops above may schedule nothing
  // more. `stop` is what the page's dispose calls; the WebView never calls it.
  const stops = (await terminalDocumentStopCalls(order))
    .toReversed()
    .map((name) => `${INDENT}${INDENT}${name}();`)
  const stopBody = [
    `${INDENT}function stop() {`,
    ...stops,
    `${INDENT}${INDENT}cancelDocumentFrames();`,
    `${INDENT}}`
  ]
  // Ruling 20: the modules above only declare. Every element read, listener and reporter install
  // runs here, in module order, and the state they read is the state the scope above was built
  // with — a call of this factory is a document, so there is nothing to reset first (ruling 22).
  //
  // A start that throws leaves the ones before it standing, and some of them hold a document
  // listener or the host's error reporter. `stop` above is the undo the document already has, and
  // every one of its calls is a no-op against a start that never ran (ruling 21), so it is what
  // unwinds a failed build — for both hosts, rather than for whichever one remembered to.
  const startBody = [
    `${INDENT}try {`,
    ...(await terminalDocumentStartCalls(order)).map((name) => `${INDENT}${INDENT}${name}();`),
    `${INDENT}} catch (error) {`,
    `${INDENT}${INDENT}stop();`,
    `${INDENT}${INDENT}throw error;`,
    `${INDENT}}`
  ]
  return [
    ...emitted,
    ...stopBody,
    ...startBody,
    `${INDENT}return { send: handleMsg, stop: stop };`
  ].join('\n')
}

/** The document's script, as the native WebView carries it: the factory, then the one call. */
export async function buildTerminalDocumentScript() {
  const body = await buildTerminalDocumentFactoryBody()
  return [
    `function ${TERMINAL_DOCUMENT_FACTORY_NAME}(${HOST_PARAMETER}) {`,
    body,
    `}`,
    `${TERMINAL_DOCUMENT_FACTORY_NAME}();`
  ].join('\n')
}

/**
 * The same factory, as a module the page imports.
 *
 * Ruling 23: one emitted body, two wrappers. The page cannot run the native script — building a
 * function from a string needs `eval`, which its policy refuses — and it cannot run the modules
 * either, because they are one singleton and the whole point of the factory is a scope per call.
 * So it imports this, whose body is the native factory's body line for line; the artifact test
 * holds the two equal, which is how the byte golden ends up pinning this file too.
 *
 * `@ts-nocheck` covers exactly one generated file. Every line below is esbuild output from a module
 * that was type-checked at its source, with its `declare global` blocks and type re-exports already
 * erased and its constants already substituted; the one line a caller reads is the signature, and
 * the generator writes that with its types.
 */
export async function buildTerminalDocumentFactoryModule() {
  const body = await buildTerminalDocumentFactoryBody()
  return [
    GENERATED_HEADER,
    '// @ts-nocheck -- ruling 23: the body is emitted text, type-checked at each source module.',
    `import type { TerminalDocument, TerminalDocumentHost } from './document/document-host-seams'`,
    '',
    `export function ${TERMINAL_DOCUMENT_FACTORY_NAME}(`,
    `${INDENT}${HOST_PARAMETER}: TerminalDocumentHost`,
    `): TerminalDocument {`,
    body,
    `}`,
    ''
  ].join('\n')
}

async function main() {
  const script = await buildTerminalDocumentScript()
  await writeFile(
    TERMINAL_DOCUMENT_SCRIPT_PATH,
    `${GENERATED_HEADER}\nexport const TERMINAL_DOCUMENT_SCRIPT = ${JSON.stringify(script)}\n`
  )
  // One run writes both, so the page's factory can never be a build behind the WebView's.
  await writeFile(TERMINAL_DOCUMENT_FACTORY_MODULE_PATH, await buildTerminalDocumentFactoryModule())
}

if (process.argv[1] === import.meta.filename) {
  await main()
}
