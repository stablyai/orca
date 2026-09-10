import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { files, option, root } from './rpc-artifact-io.mts'

/** Anchored: a bare `test-support` substring also excluded any product path containing it. */
const NOT_SOURCE = /\.test\.|(^|\/)test-support\/|\.test-support\.tsx?$|\.generated\./

const predicates: { file: string; line: number; expression: string }[] = []
for (const file of files(join(root, 'mobile/src')).filter(
  (file) => /\.tsx?$/.test(file) && !NOT_SOURCE.test(file)
)) {
  const sf = ts.createSourceFile(
    file,
    readFileSync(join(root, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  const visit = (node: ts.Node): void => {
    const expression = ts.isIfStatement(node)
      ? node.expression
      : ts.isConditionalExpression(node)
        ? node.condition
        : ts.isReturnStatement(node)
          ? node.expression
          : undefined
    if (expression && /\.ok\b|\.success\b|\bisSuccess\(/.test(expression.getText(sf))) {
      predicates.push({
        file,
        line: sf.getLineAndCharacterOfPosition(expression.getStart(sf)).line + 1,
        expression: expression.getText(sf).replace(/\s+/g, ' ')
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}
const helpers = [
  'mobile/src/transport/mobile-relay-direct-upgrade.ts:166 requireSuccess',
  'mobile/src/transport/mobile-relay-pairing-recovery.ts:297 requireSuccess',
  'mobile/src/transport/pre-profile-pairing-coordinator.ts:286 requireSuccess'
]
const text =
  '# Step 0.5 acceptance consolidation remains separate\n\nKeep all current behavior, including malformed-result exceptions; classify the following predicates into named policy families before replacing any caller. The census includes if/conditional/return expressions using `.ok`, `.success`, or `isSuccess`, with exact source locations; it deliberately retains transport and non-RPC matches for review.\n\nThree existing definitions to remove only after partition fixtures exist:\n\n' +
  helpers.map((value) => `- ${value}`).join('\n') +
  '\n\nInline predicate census:\n\n' +
  predicates
    .map((row) => `- ${row.file}:${row.line} — \`${row.expression.replace(/`/g, '\\`')}\``)
    .join('\n') +
  '\n'
const path = resolve(root, option('output', 'mobile/rpc-foundation/STEP0_5-TODO.md'))
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== text) {
    throw new Error('Stale acceptance census')
  }
} else {
  writeFileSync(path, text)
}
console.log(`acceptance census: 3 definitions, ${predicates.length} predicate expressions`)
