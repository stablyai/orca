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
const MAPPER_HOOKS = new Set(['useAnimatedStyle', 'useAnimatedProps', 'useDerivedValue'])

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : sourceFiles(path)
    }
    return sourceExtensions.has(extname(entry.name)) ? [path] : []
  })
}

/** Every mapper-hook call in the file that was not handed a dependency array. */
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
      if (MAPPER_HOOKS.has(name)) {
        const dependencies = node.arguments[1]
        if (!dependencies || !ts.isArrayLiteralExpression(dependencies)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          missing.push(`${relative(mobileDirectory, path)}:${String(line + 1)} ${name}`)
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

  it('accepts one that has a dependency array', () => {
    const found = callsMissingDependencies(
      'fixture.tsx',
      'const style = useAnimatedStyle(() => ({ opacity: progress.value }), [progress])\n'
    )
    expect(found).toEqual([])
  })
})
