import { readFileSync } from 'node:fs'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'
import { parse, productFiles } from '../navigation/router-seam-census.test-support'

const SESSION_ROOT = import.meta.dirname

/**
 * Every clipboard write on this screen has somewhere for its failure to go.
 *
 * The seam rejects when the pasteboard refused the text, which is the whole reason it exists: a
 * caller that showed "Copied" over a write that did not land was the failure it replaced. But a
 * rejection needs a reader. Seven of these sites are fire-and-forget — a sheet row's `onPress`, a
 * `void copy(...)` in a render tree — so a site without a failure branch does not merely stay
 * quiet, it raises an unhandled rejection and still leaves "Copied" on screen.
 *
 * A census rather than seven tests, because the eighth site is the one that will be written by
 * somebody who never read this file. Structural rather than behavioural on purpose: what each site
 * does about a failure is its own business, and what this holds is that it does something.
 */

/** The seam's own name, so a local helper called `writeText` is not mistaken for it. */
const SEAM_METHOD = 'writeText'
const CATCH_METHOD = 'catch'
const SEAM_HOOK = 'useClipboardWriter'

/**
 * Whether a call is answered for, by either shape this tree uses.
 *
 * `await` inside the block of a `try` that catches, or a `.catch(...)` on the promise itself.
 * Walked upward from the call rather than matched on text: both shapes put the handler somewhere
 * other than the line the write is on, and a regex over the file would pass a `catch` that belongs
 * to a different statement entirely.
 *
 * The `await` is not a formality. A promise nobody waits for settles after the block that started
 * it has returned, so a `void clipboard.writeText(...)` inside a `try` is the unhandled rejection
 * this rule exists to stop, with a `catch` above it that can never run. `return` is not enough
 * either, for the same reason: only `return await` keeps the call inside the block.
 */
function hasFailureBranch(call: ts.CallExpression): boolean {
  let node: ts.Node = call
  let awaited = false
  while (node.parent !== undefined) {
    const parent: ts.Node = node.parent
    if (ts.isAwaitExpression(parent)) {
      awaited = true
    }
    // `clipboard.writeText(x).then(...).catch(...)`: the handler is further along this same chain,
    // and `parent.expression === node` is what keeps it to this chain rather than any nearby catch.
    // Called, with something to call: `.catch` read as a property registers nothing, and `.catch()`
    // with no argument swallows the rejection while the caller goes on to say the write landed.
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === node &&
      parent.name.text === CATCH_METHOD &&
      parent.parent !== undefined &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent &&
      parent.parent.arguments.length > 0
    ) {
      return true
    }
    // `tryBlock === node` because a write inside the catch or finally clause is not answered for by
    // the try it is written in: that handler has already run.
    if (ts.isTryStatement(parent) && parent.catchClause !== undefined && parent.tryBlock === node) {
      return awaited
    }
    // Every function-like node ends the search, arrows and function expressions included: a `catch`
    // outside one answers for whoever called it, not for the call left running inside.
    if (ts.isFunctionLike(parent)) {
      return false
    }
    node = parent
  }
  return false
}

/** Every `x.writeText(...)` in a parsed module, as `file:line`, with whether its failure is handled. */
function clipboardWritesIn(
  source: ts.SourceFile,
  name: string
): { at: string; handled: boolean }[] {
  const found: { at: string; handled: boolean }[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === SEAM_METHOD
    ) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      found.push({ at: `${name}:${line}`, handled: hasFailureBranch(node) })
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return found
}

function clipboardWrites(root: string, name: string): { at: string; handled: boolean }[] {
  return clipboardWritesIn(parse(root, name), name)
}

/** A snippet read the way the census reads a module, for shapes no product file holds today. */
function writesInSnippet(source: string): { at: string; handled: boolean }[] {
  return clipboardWritesIn(
    ts.createSourceFile('snippet.ts', source, ts.ScriptTarget.Latest, true),
    'snippet.ts'
  )
}

/** Whether the census would report the single write in a snippet. */
function reports(source: string): boolean {
  const writes = writesInSnippet(source)
  if (writes.length !== 1) {
    throw new Error(`the snippet holds ${writes.length} writes, not one`)
  }
  return !writes[0].handled
}

describe('every clipboard write in the session domain answers for its failure', () => {
  const files = productFiles(SESSION_ROOT)
  const writes = files.flatMap((name) => clipboardWrites(SESSION_ROOT, name))

  it('finds the writes it is written against, so an empty list is not a pass', () => {
    // The completeness half: a rule over nothing is a rule that cannot fail. The count is a floor
    // rather than an equality, because a new copy button is not this census's business to approve.
    expect(writes.length).toBeGreaterThanOrEqual(8)
    expect(
      files.filter((name) => readFileSync(`${SESSION_ROOT}/${name}`, 'utf8').includes(SEAM_HOOK))
        .length
    ).toBeGreaterThan(0)
  })

  it('leaves none of them without one', () => {
    expect(writes.filter((write) => !write.handled).map((write) => write.at)).toEqual([])
  })
})

/**
 * What the rule counts as somewhere for a failure to go, in the shapes a product file does not hold.
 *
 * The census walks real modules, so the shapes it must refuse cannot be planted in one: a `void`
 * write is exactly the mistake it exists to catch, and it would have to be committed to be tested.
 * Snippets instead, read through the same reader, so a rule that stops matching is a red here
 * rather than a site that quietly passes for years.
 */
describe('the failure branch the census will accept', () => {
  it('refuses a write nobody waits for, however well the block around it is guarded', () => {
    // The whole point of the rule. `void` detaches the promise from the block: the `try` has
    // returned long before the rejection settles, and the process gets an unhandled rejection with
    // a `catch` sitting three lines above it that never runs.
    expect(
      reports(`
        async function copy(clipboard: Clipboard, text: string) {
          try {
            void clipboard.writeText(text)
          } catch {
            showToast("Couldn't copy")
          }
        }
      `)
    ).toBe(true)
  })

  it('refuses a write whose only catch is outside the function it sits in', () => {
    // An arrow ends the search as surely as a declaration does. The `catch` here answers for
    // `forEach`, which returns before the write it started has settled.
    expect(
      reports(`
        async function copyAll(clipboard: Clipboard, rows: string[]) {
          try {
            rows.forEach((row) => {
              clipboard.writeText(row)
            })
          } catch {
            showToast("Couldn't copy")
          }
        }
      `)
    ).toBe(true)
  })

  it('refuses a write in the catch block, which its own try does not answer for', () => {
    expect(
      reports(`
        async function copy(clipboard: Clipboard, text: string) {
          try {
            await save(text)
          } catch {
            await clipboard.writeText(text)
          }
        }
      `)
    ).toBe(true)
  })

  it('refuses a `.catch` that is read rather than called', () => {
    // `clipboard.writeText(text).catch` is the handler's name, not a handler. It registers nothing,
    // and the rejection goes exactly where it would have gone with no `catch` written at all.
    expect(
      reports(`
        function copy(clipboard: Clipboard, text: string) {
          const retry = clipboard.writeText(text).catch
          return retry
        }
      `)
    ).toBe(true)
  })

  it('refuses a `.catch()` with nothing to handle the rejection', () => {
    // Called, so the promise is handled in the sense that nothing is reported — and the user is
    // told a write landed when it did not, which is the failure this rule is written against.
    expect(
      reports(`
        function copy(clipboard: Clipboard, text: string) {
          clipboard.writeText(text).catch()
          showToast('Copied')
        }
      `)
    ).toBe(true)
  })

  it('accepts an awaited write inside a try that catches', () => {
    expect(
      reports(`
        async function copy(clipboard: Clipboard, text: string) {
          try {
            await clipboard.writeText(text)
          } catch {
            showToast("Couldn't copy")
          }
        }
      `)
    ).toBe(false)
  })

  it('accepts a write that carries its own catch along the chain', () => {
    expect(
      reports(`
        function copy(clipboard: Clipboard, text: string) {
          clipboard
            .writeText(text)
            .then(() => showToast('Copied'))
            .catch(() => showToast("Couldn't copy"))
        }
      `)
    ).toBe(false)
  })
})
