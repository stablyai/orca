import { parse } from 'es-module-lexer/js'
import { transformPluginSourceWithMappings } from '../plugin-source-sucrase-transform'
import type { PluginSourceTranspiled } from './plugin-source-transpile-protocol'

/** Types and JSX removed with lines kept (sucrase), plus the module's static import specifiers. */
export function transpilePluginSource(
  relativePath: string,
  source: string
): PluginSourceTranspiled {
  try {
    const { code, mappings } = transformPluginSourceWithMappings(relativePath, source)
    const imports = parse(code)[0].flatMap((entry) =>
      // `n` is absent for `import(expression)`, which resolves at run time like a URL.
      entry.n === undefined || entry.t === 3
        ? []
        : [{ start: entry.s, end: entry.e, specifier: entry.n }]
    )
    return { ok: true, code, mappings, imports }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
