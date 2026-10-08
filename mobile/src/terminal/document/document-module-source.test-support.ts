import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The document's own source, for the tests that assert what its code does rather than what it does.
 *
 * The document is ordinary TypeScript, so they read it directly: no build step in the loop, and the
 * text they match is the text a reader edits.
 *
 * The bundle is not a substitute. esbuild merges these modules into one scope and renames what
 * collides — the threaded `scope` parameter comes out as `scope2` — so a statement matched against
 * the bundle is matched against a rename, while the same statement in the source is the thing
 * itself. What the bundle is for is running: `native-document-bundle.test.ts` executes it.
 */
/**
 * Resolved per call, and from `import.meta.dirname` rather than from the URL.
 *
 * Per call because a module body does no work, which the parse-time census holds for. From
 * `dirname` because a case in the DOM environment has no file URL to convert: `import.meta.url`
 * there is not a `file:` one, and `fileURLToPath` refuses it.
 */
const documentDirectory = () => import.meta.dirname

const isDocumentModule = (name: string) =>
  name.endsWith('.ts') && !name.includes('.test.') && !name.includes('.test-support.')

/** One module's own source. */
export function documentModuleSource(name: string): string {
  return readFileSync(join(documentDirectory(), `${name}.ts`), 'utf8')
}

/**
 * Every module's source, concatenated.
 *
 * Read from the directory rather than from a list, so a module added to the document is covered
 * without this being edited and a test cannot silently stop matching because its subject moved
 * between files.
 */
export function documentSourceText(): string {
  return readdirSync(documentDirectory())
    .filter(isDocumentModule)
    .sort()
    .map((name) => readFileSync(join(documentDirectory(), name), 'utf8'))
    .join('\n')
}

/**
 * Everything the WebView's page is made of: the document's modules, plus the HTML around them.
 *
 * The shell, the markup and the stylesheet are not document modules — they are the page the
 * document is loaded into, and they are written where the WebView's HTML is assembled. A case about
 * what the WebView runs, rather than about what the document does, reads all of it.
 */
export function webviewPageSource(): string {
  const html = join(documentDirectory(), '..', 'terminal-webview-html')
  return [
    documentSourceText(),
    ...readdirSync(html)
      .filter((name) => name.endsWith('.ts') && !name.includes('.test'))
      .sort()
      .map((name) => readFileSync(join(html, name), 'utf8'))
  ].join('\n')
}
