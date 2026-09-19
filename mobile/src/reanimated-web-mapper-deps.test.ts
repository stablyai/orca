import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { extname, join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const mobileDirectory = fileURLToPath(new URL('..', import.meta.url))
const scanned = ['src', 'app']
const sourceExtensions = new Set(['.ts', '.tsx'])

/**
 * Reanimated hooks whose updater becomes a mapper, and which therefore need to know which shared
 * values the updater reads.
 *
 * On native the Babel plugin writes `updater.__closure` and Reanimated reads the inputs off it.
 * The mobile web bundle is built by esbuild (config/scripts/build-mobile-web-app-bundle.mjs), which
 * runs no Babel, so `__closure` is undefined and `inputs` falls back to the dependency array —
 * and with neither, `startMapper` registers a mapper that listens to nothing. It runs once and
 * never again, freezing whatever the first frame wrote. That is silent: the throw Reanimated has
 * for this case is behind `__DEV__`, which the bundle builds out.
 */
const MAPPER_HOOKS = new Map([
  ['useAnimatedStyle', { updaters: [0], dependencies: 1 }],
  ['useAnimatedProps', { updaters: [0], dependencies: 1 }],
  ['useDerivedValue', { updaters: [0], dependencies: 1 }],
  // Third argument, not second: `useAnimatedReaction(prepare, react, dependencies)`. Both
  // callbacks run inside the one mapper it starts (hook/useAnimatedReaction.js:38-50), so both
  // are updaters.
  ['useAnimatedReaction', { updaters: [0, 1], dependencies: 2 }]
])

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : sourceFiles(path)
    }
    return sourceExtensions.has(extname(entry.name)) ? [path] : []
  })
}

/** Whether this `X.value` is being written rather than read. A write is an output, not an input. */
function isWriteTarget(node: ts.PropertyAccessExpression): boolean {
  const parent = node.parent
  if (ts.isBinaryExpression(parent) && parent.left === node) {
    // `=` through `??=`: every assignment operator sits in this one contiguous token range.
    return (
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
  }
  if (ts.isPrefixUnaryExpression(parent)) {
    // Only `++x` and `--x` mutate. `!x.value`, `-x.value`, `+x.value` and `~x.value` are reads,
    // and taking every prefix operator for a write dropped those from the array's requirement.
    return (
      parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken
    )
  }
  // Postfix has no other operators: `x.value++` and `x.value--` are the whole set.
  return ts.isPostfixUnaryExpression(parent)
}

/**
 * What each local name in this file means, for the hooks above, resolved through its imports.
 *
 * Matching on the callee's spelling would both miss and invent: `useAnimatedStyle as useAS` and
 * `Reanimated.useAnimatedStyle` are the same hook under another name, and a local helper that
 * happens to be called `useDerivedValue` is not this hook at all. Returns the local identifiers
 * bound to each hook, plus the namespace names a member access has to go through.
 */
function reanimatedBindings(sourceFile: ts.SourceFile): {
  byLocalName: Map<string, string>
  namespaces: Set<string>
} {
  const byLocalName = new Map<string, string>()
  const namespaces = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'react-native-reanimated'
    ) {
      continue
    }
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text)
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text
        if (MAPPER_HOOKS.has(imported)) {
          byLocalName.set(element.name.text, imported)
        }
      }
    }
    // The default export is the `Animated` namespace object, which carries no hooks.
  }
  return { byLocalName, namespaces }
}

/** The hook this callee names, or null when it is not one of ours. */
function resolveHook(
  callee: ts.Expression,
  bindings: ReturnType<typeof reanimatedBindings>
): string | null {
  if (ts.isIdentifier(callee)) {
    return bindings.byLocalName.get(callee.text) ?? null
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    bindings.namespaces.has(callee.expression.text) &&
    MAPPER_HOOKS.has(callee.name.text)
  ) {
    return callee.name.text
  }
  return null
}

/** Every `X` in an `X.value` read under this node, which is what the mapper has to listen to. */
function sharedValuesRead(updater: ts.Node): Set<string> {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'value' &&
      ts.isIdentifier(node.expression) &&
      !isWriteTarget(node)
    ) {
      names.add(node.expression.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(updater)
  return names
}

/** The identifiers a dependency array lists, ignoring entries that are not plain names. */
function namesListed(dependencies: ts.ArrayLiteralExpression): Set<string> {
  return new Set(dependencies.elements.filter(ts.isIdentifier).map((element) => element.text))
}

/**
 * Every mapper-hook call that was not handed a dependency array, or was handed one that leaves a
 * shared value out.
 *
 * The second half is the one an array alone does not give: `inputs` becomes exactly the array
 * (hook/useAnimatedStyle.js:338-341), so a value the updater reads but the array omits is a value
 * the mapper never listens to. That updater then stops re-running when only that value changes,
 * which is the same freeze as having no array at all, in one prop instead of all of them.
 */
function callsMissingDependencies(path: string, source: string, found: string[] = []): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    extname(path) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const bindings = reanimatedBindings(sourceFile)
  const missing: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = resolveHook(node.expression, bindings)
      const hook = name === null ? undefined : MAPPER_HOOKS.get(name)
      if (name !== null && hook) {
        found.push(name)
        const dependencies = node.arguments[hook.dependencies]
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        const where = `${relative(mobileDirectory, path)}:${String(line + 1)} ${name}`
        if (!dependencies) {
          missing.push(where)
        } else if (!ts.isArrayLiteralExpression(dependencies)) {
          // An array built elsewhere counts as present: the hook only needs one to exist, and
          // this file cannot see what a hoisted `const deps = [...]` holds. Completeness below
          // therefore covers literal arrays only.
        } else {
          const listed = namesListed(dependencies)
          const read = hook.updaters.flatMap((index) => {
            const updater = node.arguments[index]
            return updater ? [...sharedValuesRead(updater)] : []
          })
          for (const value of [...new Set(read)].sort()) {
            if (!listed.has(value)) {
              missing.push(`${where} omits ${value}`)
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return missing
}

describe('reanimated mapper hooks in the web bundle', () => {
  it('are all given a dependency array, because esbuild writes no worklet closure', () => {
    const found: string[] = []
    const missing = scanned.flatMap((directory) =>
      sourceFiles(join(mobileDirectory, directory)).flatMap((path) =>
        path.endsWith('.test.ts') || path.endsWith('.test.tsx')
          ? []
          : callsMissingDependencies(path, readFileSync(path, 'utf8'), found)
      )
    )
    // The precondition the empty list above rests on. Binding resolution means a broken resolver
    // reports nothing at all, which would read exactly like a clean tree.
    expect(found.length).toBeGreaterThanOrEqual(5)
    expect(missing).toEqual([])
  })

  const FROM = "import { useAnimatedStyle, useAnimatedReaction } from 'react-native-reanimated'\n"

  it('finds a call with no dependency array, which is what makes the census above real', () => {
    const found = callsMissingDependencies(
      'fixture.tsx',
      `${FROM}const s = useAnimatedStyle(() => ({ opacity: progress.value }))\n`
    )
    expect(found).toEqual(['fixture.tsx:2 useAnimatedStyle'])
  })

  it('reads useAnimatedReaction dependencies from its third argument, not its second', () => {
    expect(
      callsMissingDependencies(
        'fixture.tsx',
        `${FROM}useAnimatedReaction(() => progress.value, (v) => { opacity.value = v })\n`
      )
    ).toEqual(['fixture.tsx:2 useAnimatedReaction'])
    expect(
      callsMissingDependencies(
        'fixture.tsx',
        `${FROM}useAnimatedReaction(() => progress.value, (v) => { opacity.value = v }, [progress])\n`
      )
    ).toEqual([])
  })

  it('names a shared value the updater reads but the array leaves out', () => {
    const found = callsMissingDependencies(
      'fixture.tsx',
      `${FROM}const s = useAnimatedStyle(() => ({ opacity: progress.value * fade.value }), [progress])\n`
    )
    expect(found).toEqual(['fixture.tsx:2 useAnimatedStyle omits fade'])
  })

  it('does not ask for a value the updater only writes, which is an output', () => {
    const found = callsMissingDependencies(
      'fixture.tsx',
      `${FROM}useAnimatedReaction(() => progress.value, (v) => { opacity.value = v }, [progress])\n`
    )
    expect(found).toEqual([])
  })

  it('still asks for one that is read and written', () => {
    const found = callsMissingDependencies(
      'fixture.tsx',
      `${FROM}const s = useAnimatedStyle(() => { offset.value = offset.value + 1; return {} }, [])\n`
    )
    expect(found).toEqual(['fixture.tsx:2 useAnimatedStyle omits offset'])
  })

  it('still asks for a value read under a negation, which is not a write', () => {
    const found = callsMissingDependencies(
      'fixture.tsx',
      `${FROM}const s = useAnimatedStyle(() => ({ opacity: !hidden.value ? 1 : 0 }), [])\n`
    )
    expect(found).toEqual(['fixture.tsx:2 useAnimatedStyle omits hidden'])
  })

  it('and one read under a unary minus', () => {
    const found = callsMissingDependencies(
      'fixture.tsx',
      `${FROM}const s = useAnimatedStyle(() => ({ top: -offset.value }), [])\n`
    )
    expect(found).toEqual(['fixture.tsx:2 useAnimatedStyle omits offset'])
  })

  it('does not ask for one that is only incremented', () => {
    const found = callsMissingDependencies(
      'fixture.tsx',
      `${FROM}const s = useAnimatedStyle(() => { count.value++; return {} }, [])\n`
    )
    expect(found).toEqual([])
  })

  it('accepts one that has a dependency array', () => {
    const found = callsMissingDependencies(
      'fixture.tsx',
      `${FROM}const s = useAnimatedStyle(() => ({ opacity: progress.value }), [progress])\n`
    )
    expect(found).toEqual([])
  })

  it('sees the hook through an alias, which spelling alone would miss', () => {
    const found = callsMissingDependencies(
      'fixture.tsx',
      "import { useAnimatedStyle as useAS } from 'react-native-reanimated'\n" +
        'const s = useAS(() => ({ opacity: progress.value }))\n'
    )
    expect(found).toEqual(['fixture.tsx:2 useAnimatedStyle'])
  })

  it('sees it through a namespace import too', () => {
    const found = callsMissingDependencies(
      'fixture.tsx',
      "import * as Reanimated from 'react-native-reanimated'\n" +
        'const s = Reanimated.useAnimatedStyle(() => ({ opacity: progress.value }))\n'
    )
    expect(found).toEqual(['fixture.tsx:2 useAnimatedStyle'])
  })

  it('leaves a local function of the same name alone', () => {
    const found = callsMissingDependencies(
      'fixture.tsx',
      'function useDerivedValue(fn: () => number) { return fn() }\n' +
        'const v = useDerivedValue(() => progress.value)\n'
    )
    expect(found).toEqual([])
  })

  it('takes an array built elsewhere as present rather than missing', () => {
    const found = callsMissingDependencies(
      'fixture.tsx',
      `${FROM}const deps = [progress]\n` +
        'const s = useAnimatedStyle(() => ({ opacity: progress.value }), deps)\n'
    )
    expect(found).toEqual([])
  })
})
