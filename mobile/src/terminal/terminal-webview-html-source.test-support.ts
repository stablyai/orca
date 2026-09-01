import { readFileSync } from 'node:fs'

const SOURCE_FILES = [
  './terminal-webview-html.ts',
  ...Array.from(
    { length: 10 },
    (_, index) => `./terminal-webview-html/fragment-${String(index + 1).padStart(2, '0')}.ts`
  )
] as const

/** Reads the TypeScript source that assembles the in-WebView document. */
export function readTerminalWebViewHtmlSource(): string {
  return SOURCE_FILES.map((relativePath) =>
    readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  ).join('\n')
}
