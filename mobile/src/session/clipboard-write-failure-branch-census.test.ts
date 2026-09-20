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
const SEAM_HOOK = 'useClipboardWriter'

/**
 * Whether a call is answered for, by either shape this tree uses.
 *
 * `await` inside a `try` with a `catch`, or a `.catch(...)` on the promise itself. Walked upward
 * from the call rather than matched on text: both shapes put the handler somewhere other than the
 * line the write is on, and a regex over the file would pass a `catch` that belongs to a different
 * statement entirely.
 */
function hasFailureBranch(call: ts.Node): boolean {
  let node: ts.Node | undefined = call
  while (node !== undefined) {
    if (ts.isTryStatement(node) && node.catchClause !== undefined) {
      return true
    }
    // `clipboard.writeText(x).then(...).catch(...)`: the catch is further out in the same chain.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'catch'
    ) {
      return true
    }
    // A function boundary ends the search: a `catch` outside it belongs to a different call.
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      return false
    }
    node = node.parent
  }
  return false
}

/** Every `x.writeText(...)` in a module, as `file:line`, with whether its failure is handled. */
function clipboardWrites(root: string, name: string): { at: string; handled: boolean }[] {
  const source = parse(root, name)
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
