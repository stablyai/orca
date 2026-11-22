import { posix } from 'node:path'
import { transform } from 'sucrase'

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

/**
 * Types and JSX removed with lines kept (sucrase), as an ES module with an inline source map.
 * Shared by frames and workers so a plugin file transpiles the same wherever it runs. Throws on
 * a syntax error.
 */
export function transformPluginSource(relativePath: string, source: string): string {
  return transformPluginSourceWithMappings(relativePath, source).code
}

/** The same, plus the map's VLQ `mappings` for frames that locate errors without DevTools. */
export function transformPluginSourceWithMappings(
  relativePath: string,
  source: string
): { code: string; mappings: string } {
  const result = transform(source, {
    transforms: TRANSFORMS_BY_EXTENSION[posix.extname(relativePath).toLowerCase()] ?? [],
    jsxRuntime: 'automatic',
    jsxImportSource: 'orca',
    production: true,
    // Why: Chromium and the worker's Node run modern syntax as written; only types and JSX go.
    disableESTransforms: true,
    filePath: relativePath,
    sourceMapOptions: { compiledFilename: posix.basename(relativePath) }
  })
  return {
    code: result.code + inlineSourceMap(result.sourceMap, relativePath, source),
    mappings: result.sourceMap?.mappings ?? ''
  }
}
