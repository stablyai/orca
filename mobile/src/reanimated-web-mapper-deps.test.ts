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
  return ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)
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
function callsMissingDependencies(path: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    extname(path) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const missing: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text
      const hook = MAPPER_HOOKS.get(name)
      if (hook) {
        const dependencies = node.arguments[hook.dependencies]
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        const where = `${relative(mobileDirectory, path)}:${String(line + 1)} ${name}`
        if (!dependencies || !ts.isArrayLiteralExpression(dependencies)) {
          missing.push(where)
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
    const missing = scanned.flatMap((directory) =>
      sourceFiles(join(mobileDirectory, directory)).flatMap((path) =>
        path.endsWith('.test.ts') || path.endsWith('.test.tsx')
          ? []
          : callsMissingDependencies(path, readFileSync(path, 'utf8'))
      )
    )
    expect(missing).toEqual([])
  })

  it('finds a call with no dependency array, which is what makes the census above real', () => {
    const found = callsMissingDependencies(
      'fixture.tsx',
      'const style = useAnimatedStyle(() => ({ opacity: progress.value }))\n'
    )
    expect(found).toEqual(['fixture.tsx:1 useAnimatedStyle'])
  })

  it('reads useAnimatedReaction dependencies from its third argument, not its second', () => {
    const missing = callsMissingDependencies(
      'fixture.tsx',
      'useAnimatedReaction(() => progress.value, (v) => { opacity.value = v })\n'
    )
    expect(missing).toEqual(['fixture.tsx:1 useAnimatedReaction'])
    expect(
      callsMissingDependencies(
        'fixture.tsx',
        'useAnimatedReaction(() => progress.value, (v) => { opacity.value = v }, [progress])\n'
      )
    ).toEqual([])
  })

  it('names a shared value the updater reads but the array leaves out', () => {
    const found = callsMissingDependencies(
      'fixture.tsx',
      'const s = useAnimatedStyle(() => ({ opacity: progress.value * fade.value }), [progress])\n'
    )
    expect(found).toEqual(['fixture.tsx:1 useAnimatedStyle omits fade'])
  })

  it('does not ask for a value the updater only writes, which is an output', () => {
    const found = callsMissingDependencies(
      'fixture.tsx',
      'useAnimatedReaction(() => progress.value, (v) => { opacity.value = v }, [progress])\n'
    )
    expect(found).toEqual([])
  })

  it('still asks for one that is read and written', () => {
    const found = callsMissingDependencies(
      'fixture.tsx',
      'const s = useAnimatedStyle(() => { offset.value = offset.value + 1; return {} }, [])\n'
    )
    expect(found).toEqual(['fixture.tsx:1 useAnimatedStyle omits offset'])
  })

  it('accepts one that has a dependency array', () => {
    const found = callsMissingDependencies(
      'fixture.tsx',
      'const style = useAnimatedStyle(() => ({ opacity: progress.value }), [progress])\n'
    )
    expect(found).toEqual([])
  })
})
