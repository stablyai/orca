import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Build output, which a source census reads as source and must not.
 *
 * `mobile/.gitignore` is the list: five `*.generated.ts` files under `mobile/src`, written by the
 * postinstall generators. Two are vendored engines — 3.7 MB of mermaid for the native WebView and
 * 3.5 MB of it for the page — and 7.9 MB of what a walk over this tree returns is generated. A
 * census that parses them parses minified third-party code looking for call sites nobody in this
 * repo wrote and nobody can move, and pays the whole parse to find them: five of those files is
 * what took `rpc-params-contract-type-only-boundary` from 1.5 s to over its 5 s timeout in CI.
 *
 * The generator that writes each one is ordinary source and is still walked, which is where a real
 * reach into whatever a census is fencing would be.
 */
export function isGeneratedSource(name: string): boolean {
  return /\.generated\.tsx?$/.test(name)
}

/**
 * Every file under `directory`, absolute, without `node_modules` or build output.
 *
 * Nine censuses in this tree held a copy of this walk, and two of them had grown a private opinion
 * about generated files while the rest had none. What each census counts as *interesting* — which
 * extensions, whether test files are in — stays its own business, because they genuinely disagree;
 * what counts as a source file at all does not.
 */
export function censusSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : censusSourceFiles(path)
    }
    return isGeneratedSource(entry.name) ? [] : [path]
  })
}
