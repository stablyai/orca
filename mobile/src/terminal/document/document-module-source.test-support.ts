import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Read source for structural checks: bundling merges scopes and renames identifiers. Execute bundles in their own tests.
// Resolve per call to keep module evaluation inert; DOM tests lack file URLs, so use import.meta.dirname.
const documentDirectory = () => import.meta.dirname

const isDocumentModule = (name: string) =>
  name.endsWith('.ts') && !name.includes('.test.') && !name.includes('.test-support.')

export function documentModuleSource(name: string): string {
  return readFileSync(join(documentDirectory(), `${name}.ts`), 'utf8')
}

// Read the directory so moving or adding document modules cannot silently evade source checks.
export function documentSourceText(): string {
  return readdirSync(documentDirectory())
    .filter(isDocumentModule)
    .sort()
    .map((name) => readFileSync(join(documentDirectory(), name), 'utf8'))
    .join('\n')
}

// WebView checks include the surrounding HTML and styles as well as the document modules.
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
