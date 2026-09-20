import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { terminalDocumentStartCalls } from '../../../scripts/build-terminal-document-script.mjs'
import {
  TERMINAL_DOCUMENT_HOST_SEAMS_MODULE,
  TERMINAL_DOCUMENT_MODULE_ORDER,
  TERMINAL_DOCUMENT_SCOPE_MODULE
} from '../../../scripts/terminal-document-module-order.mjs'

/**
 * The page runs the document's modules in the order the WebView's script runs them.
 *
 * It has to: the document is one function scope, so `runtime-constants` taking the surface before
 * `surface-swap` captures it is not a dependency the graph records. Inside the WebView the
 * generator reads the order from one file; on the page the order is the import list in
 * `page-document-modules.ts`, and nothing but this holds the two together. A formatter that sorted
 * that list, or a module added to the generator and not to the page, would leave both sides green
 * and the page running a different program.
 *
 * Read as text rather than by importing the module, because importing it would run the document
 * against an empty body and prove only that the file parses.
 */
const pageEntry = readFileSync(new URL('./page-document-modules.ts', import.meta.url), 'utf8')

/** `message-bridge` is ruling 19's exclusion: on the page those frames belong to the shell. */
const EXCLUDED = ['message-bridge']

function importedModules(): string[] {
  return [...pageEntry.matchAll(/^import (?:\{[^}]*\} from )?'\.\/([a-z0-9-]+)'$/gm)].map(
    (match) => match[1]!
  )
}

describe('the page entry for the terminal document', () => {
  it('imports every module the generator emits, in the same order, minus the bridge', () => {
    expect(importedModules()).toEqual([
      TERMINAL_DOCUMENT_HOST_SEAMS_MODULE,
      TERMINAL_DOCUMENT_SCOPE_MODULE,
      ...TERMINAL_DOCUMENT_MODULE_ORDER.filter((name) => !EXCLUDED.includes(name))
    ])
  })

  it('names its exclusion, and the exclusion is a module the generator does emit', () => {
    for (const name of EXCLUDED) {
      expect(TERMINAL_DOCUMENT_MODULE_ORDER).toContain(name)
      expect(importedModules()).not.toContain(name)
    }
  })

  it('calls the same start sequence the generated document calls, minus the bridge', async () => {
    // Ruling 20's other half. The import list above only proves the page reaches the same
    // modules; what runs is the call sequence, and the generator writes its own from the same
    // sources. A module that grows a start function and is not called here would leave the page
    // with an element nobody read.
    const sequence = [...pageEntry.matchAll(/^ {2,4}(start[A-Za-z]+)\(\)$/gm)].map(
      (match) => match[1]!
    )
    const emitted = await terminalDocumentStartCalls([
      TERMINAL_DOCUMENT_HOST_SEAMS_MODULE,
      TERMINAL_DOCUMENT_SCOPE_MODULE,
      ...TERMINAL_DOCUMENT_MODULE_ORDER
    ])
    expect(sequence.length).toBeGreaterThan(0)
    expect(sequence).toEqual(emitted.filter((name) => name !== 'startMessageBridge'))
  })

  it('would report a reordered list', () => {
    // The precondition for the first case: a matcher that found nothing would agree with an empty
    // expectation just as happily. Swapping the first two names must break it.
    const [first, second, ...rest] = importedModules()
    expect([second, first, ...rest]).not.toEqual([
      TERMINAL_DOCUMENT_HOST_SEAMS_MODULE,
      TERMINAL_DOCUMENT_SCOPE_MODULE,
      ...TERMINAL_DOCUMENT_MODULE_ORDER.filter((name) => !EXCLUDED.includes(name))
    ])
  })
})
