import { readFileSync } from 'node:fs'

const COMPOSER_FILE = './terminal-webview-html.ts'
const SLICE_IMPORT_RE = /^import \{[^}]*\} from '(\.\/terminal-webview-html\/[\w-]+)'$/gm
const COMPOSED_ENTRY_RE = /^ {2}TERMINAL_HTML_\w+,?$/gm

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

/**
 * Reads the TypeScript source that assembles the in-WebView document.
 *
 * Why: the slice list is derived from the composer's own imports rather than duplicated, so a
 * new slice cannot join the emitted document while staying invisible to the tests that search
 * this source. The count cross-check catches an import shape the regex cannot see.
 */
export function readTerminalWebViewHtmlSource(): string {
  const composer = readSource(COMPOSER_FILE)
  const slices = [...composer.matchAll(SLICE_IMPORT_RE)].map((match) => `${match[1]}.ts`)
  const composedCount = [...composer.matchAll(COMPOSED_ENTRY_RE)].length
  if (composedCount === 0) {
    throw new Error('no composed WebView document slices found')
  }
  if (slices.length !== composedCount) {
    throw new Error(
      `WebView document slice imports (${slices.length}) do not match composed entries (${composedCount})`
    )
  }
  return [composer, ...slices.map(readSource)].join('\n')
}
