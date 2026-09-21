import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildTerminalDocumentScript,
  emitTerminalDocumentModule
} from '../../../scripts/build-terminal-document-script.mjs'
import {
  TERMINAL_DOCUMENT_HOST_SEAMS_MODULE,
  TERMINAL_DOCUMENT_MODULE_ORDER,
  TERMINAL_DOCUMENT_SCOPE_MODULE
} from '../../../scripts/terminal-document-module-order.mjs'

/**
 * Every module in this directory is in the document, and everything in the order list is here.
 *
 * The generator emits exactly what the order list names, so a module added here and forgotten
 * there is dead code that reads as live, and a name left in the list after its file goes makes the
 * generator throw at build time rather than at review time. Both directions are asserted.
 *
 * Three files are deliberately not emitted into the document, each for its own reason, and they
 * are named rather than filtered by a pattern so a fourth cannot join them by looking similar.
 */
const NOT_EMITTED = [
  // Its exports are substituted into the modules that import them as literals, so the document
  // carries its values without carrying the module.
  'document-constants',
  // Types only. esbuild emits nothing for it, and an empty emission would add a blank line to the
  // document rather than a program.
  'document-terminal-shape',
  // The page's entry, not the WebView's: it imports the modules below in the order the generator
  // emits them, because on the page nothing splices them into one scope.
  // `page-document-module-order.test.ts` holds its list against this one.
  'page-document-modules'
]

function documentModuleNames(): string[] {
  return readdirSync(new URL('.', import.meta.url))
    .filter((entry) => entry.endsWith('.ts'))
    .filter((entry) => !entry.endsWith('.test.ts') && !entry.endsWith('.test-support.ts'))
    .map((entry) => entry.slice(0, -'.ts'.length))
    .sort()
}

describe('the document module order', () => {
  it('names every module the directory holds, and only those', () => {
    const expected = [
      ...NOT_EMITTED,
      TERMINAL_DOCUMENT_HOST_SEAMS_MODULE,
      TERMINAL_DOCUMENT_SCOPE_MODULE,
      ...TERMINAL_DOCUMENT_MODULE_ORDER
    ].sort()
    expect(documentModuleNames()).toEqual(expected)
  })

  it('names each module once, so the generator cannot emit one twice', () => {
    const listed = [
      TERMINAL_DOCUMENT_HOST_SEAMS_MODULE,
      TERMINAL_DOCUMENT_SCOPE_MODULE,
      ...TERMINAL_DOCUMENT_MODULE_ORDER
    ]
    expect(listed).toHaveLength(new Set(listed).size)
  })

  it('emits nothing for the types-only module, which is why it is an exception', async () => {
    // The reason `document-terminal-shape` is not in the order list, measured rather than
    // asserted in prose: esbuild erases a module of type declarations to the empty string, and
    // emitting it would put a blank line in the document instead of a program. If it ever
    // declared a value this goes red, and the module belongs in the order list with its own line
    // in the golden diff.
    const emitted = await emitTerminalDocumentModule(
      fileURLToPath(new URL('./document-terminal-shape.ts', import.meta.url))
    )
    expect(emitted).toBe('')
  })

  it('emits the host seams ahead of the scope, whose defaults are those six functions', async () => {
    // Order in the emitted document, not membership in a list: `createTerminalDocumentScope()`
    // runs as the script is parsed and reads the six by name, so a seams module emitted after it
    // would throw on the document's first line. Non-membership cannot see that — it is satisfied
    // by any arrangement — so the two texts are located in the document the generator produces.
    expect(TERMINAL_DOCUMENT_MODULE_ORDER).not.toContain(TERMINAL_DOCUMENT_HOST_SEAMS_MODULE)
    expect(TERMINAL_DOCUMENT_HOST_SEAMS_MODULE).not.toBe(TERMINAL_DOCUMENT_SCOPE_MODULE)

    const script = await buildTerminalDocumentScript()
    const emittedAt = async (name: string) => {
      const text = await emitTerminalDocumentModule(
        fileURLToPath(new URL(`./${name}.ts`, import.meta.url))
      )
      const at = script.indexOf(text)
      expect(at, `${name} is not in the emitted document`).toBeGreaterThanOrEqual(0)
      return at
    }
    expect(await emittedAt(TERMINAL_DOCUMENT_HOST_SEAMS_MODULE)).toBeLessThan(
      await emittedAt(TERMINAL_DOCUMENT_SCOPE_MODULE)
    )
  })
})
