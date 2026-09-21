import { fileURLToPath } from 'node:url'
import { emitTerminalDocumentModule } from '../../../scripts/build-terminal-document-script.mjs'
import { XTERM_HTML } from '../terminal-webview-html'

const SCOPE_OPEN = '(function() {\n'
// The first declaration the document makes once the scope object exists. Ruling 20 left the
// modules below with no top-level statements at all, so the anchor is a declaration rather than
// the surface read that used to open them.
const FIRST_STATEMENT_AFTER_SCOPE = '  function startRuntimeConstants() {'

/**
 * The scope object the document opens with. Every block below it reads and writes document state
 * through this one object, so a test that evaluates a block has to build it first.
 */
export function documentScopePreamble(): string {
  const start = XTERM_HTML.indexOf(SCOPE_OPEN)
  const end = XTERM_HTML.indexOf(FIRST_STATEMENT_AFTER_SCOPE, start)
  if (start === -1 || end <= start) {
    throw new Error('the document does not open with the scope object')
  }
  return XTERM_HTML.slice(start + SCOPE_OPEN.length, end)
}

/**
 * One module's text as the document carries it. The module is re-emitted and then located in the
 * document, so a test that evaluates the result is running the WebView's own bytes, not a
 * parallel copy of them.
 */
export async function generatedDocumentModule(name: string): Promise<string> {
  const emitted = await emitTerminalDocumentModule(
    fileURLToPath(new URL(`./${name}.ts`, import.meta.url))
  )
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
