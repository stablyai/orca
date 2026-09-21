import { emitDocumentedTerminalModule } from '../../../scripts/build-terminal-document-script.mjs'
import {
  TERMINAL_DOCUMENT_MODULE_ORDER,
  terminalDocumentStartFunctionName
} from '../../../scripts/terminal-document-module-order.mjs'
import { XTERM_HTML } from '../terminal-webview-html'

const SCOPE_OPEN = 'function createTerminalDocument(host) {\n'
const DOCUMENT_CALL = 'createTerminalDocument();'

/**
 * The document's whole program: the factory the script declares and the one call that runs it.
 *
 * Ruling 22 made the document a function, so a test that evaluates the program gets a declaration
 * and a call rather than an IIFE. Held here rather than in each test file, which is where four
 * copies of the old slice lived.
 */
export function generatedDocumentProgram(): string {
  const start = XTERM_HTML.indexOf(SCOPE_OPEN)
  const end = XTERM_HTML.lastIndexOf(DOCUMENT_CALL)
  if (start === -1 || end <= start) {
    throw new Error('the document does not carry the factory and its call')
  }
  return XTERM_HTML.slice(start, end + DOCUMENT_CALL.length)
}
// The first declaration the document makes once the scope object exists. Ruling 20 left the
// modules below with no top-level statements at all, so the anchor is a declaration rather than
// the surface read that used to open them.
const FIRST_STATEMENT_AFTER_SCOPE = '  function startRuntimeConstants() {'

/**
 * The scope object the document opens with. Every block below it reads and writes document state
 * through this one object, so a test that evaluates a block has to build it first.
 *
 * Ruling 22 made the document a factory, so the text below reads the `host` argument the factory
 * was called with. A block evaluated on its own has no factory around it, so the preamble declares
 * the argument the WebView's own call passes: none, which is every seam on its window default.
 */
export function documentScopePreamble(): string {
  const start = XTERM_HTML.indexOf(SCOPE_OPEN)
  const end = XTERM_HTML.indexOf(FIRST_STATEMENT_AFTER_SCOPE, start)
  if (start === -1 || end <= start) {
    throw new Error('the document does not open as the factory')
  }
  return `const host = undefined;\n${XTERM_HTML.slice(start + SCOPE_OPEN.length, end)}`
}

/**
 * One module's text as the document carries it. The module is re-emitted and then located in the
 * document, so a test that evaluates the result is running the WebView's own bytes, not a
 * parallel copy of them.
 */
export async function generatedDocumentModule(name: string): Promise<string> {
  const emitted = await emitDocumentedTerminalModule(name)
  if (!XTERM_HTML.includes(emitted)) {
    throw new Error(`the document does not carry the ${name} module; rebuild the document script`)
  }
  return emitted
}

/**
 * A function the document's own text declared, read out of the context it was evaluated in. The
 * name is checked to be callable, so only its parameter and return types are the caller's claim.
 */
export function documentDeclaredFunction<T extends (...args: never[]) => unknown>(
  context: Record<string, unknown>,
  name: string
): T {
  const value = context[name]
  if (typeof value !== 'function') {
    throw new Error(`the document text did not declare ${name}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: checked callable above.
  return value as T
}

/**
 * Every module's start, over the scope these modules import, in the order the generator calls them.
 *
 * Test support, and only that: a document starts inside the generated factory now, over a scope
 * built for that one call (ruling 22). A test that drives these modules directly is driving the
 * shared scope instead, and it still needs the element reads and listener installs the starts do.
 *
 * Derived from the generator's own order and naming convention rather than listed, so a module
 * that gains a start is covered without this being edited — which is what the page's deleted entry
 * module was for.
 */
export async function startDocumentModulesOverTheSharedScope() {
  for (const name of TERMINAL_DOCUMENT_MODULE_ORDER) {
    // `@vite-ignore` because the specifier is a variable and these modules are this file's own
    // neighbours: the analysis that would otherwise rewrite it as a glob refuses to glob the
    // directory it is written in, and warns on every run of any suite that loads this file.
    const loaded: Record<string, unknown> = await import(/* @vite-ignore */ `./${name}`)
    const start = loaded[terminalDocumentStartFunctionName(name)]
    if (typeof start === 'function') {
      start()
    }
  }
}
