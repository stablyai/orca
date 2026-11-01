import { posix } from 'node:path'
import { parse } from 'es-module-lexer/js'
import { transform } from 'sucrase'
import type { PluginSourceTranspiled } from './plugin-source-transpile-protocol'

const TRANSFORMS_BY_EXTENSION: Record<string, ('typescript' | 'jsx')[]> = {
  '.ts': ['typescript'],
  '.mts': ['typescript'],
  '.tsx': ['typescript', 'jsx'],
  '.jsx': ['jsx']
}

type SourceMap = ReturnType<typeof transform>['sourceMap']

function inlineSourceMap(map: SourceMap, relativePath: string, source: string): string {
  const withSource = { ...map, sources: [posix.basename(relativePath)], sourcesContent: [source] }
  const encoded = Buffer.from(JSON.stringify(withSource), 'utf8').toString('base64')
  return `\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${encoded}\n`
}

/** Types and JSX removed with lines kept (sucrase), plus the module's static import specifiers. */
export function transpilePluginSource(
  relativePath: string,
  source: string
): PluginSourceTranspiled {
  try {
    const result = transform(source, {
      transforms: TRANSFORMS_BY_EXTENSION[posix.extname(relativePath).toLowerCase()] ?? [],
      jsxRuntime: 'automatic',
      jsxImportSource: 'orca',
      production: true,
      // Why: Chromium runs modern syntax as written; only types and JSX need removing.
      disableESTransforms: true,
      filePath: relativePath,
      sourceMapOptions: { compiledFilename: posix.basename(relativePath) }
    })
    const imports = parse(result.code)[0].flatMap((entry) =>
      // `n` is absent for `import(expression)`, which resolves at run time like a URL.
      entry.n === undefined || entry.t === 3
        ? []
        : [{ start: entry.s, end: entry.e, specifier: entry.n }]
    )
    return {
      ok: true,
      code: result.code + inlineSourceMap(result.sourceMap, relativePath, source),
      imports
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
