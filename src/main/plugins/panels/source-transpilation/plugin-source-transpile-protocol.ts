/** Messages between main and the plugin source transpile worker; no transpiler imports here. */

/** Part of every cache key; a test pins it to the bundled sucrase version. */
export const PLUGIN_SOURCE_TRANSPILER_ID = 'sucrase@3.35.1'

export type PluginSourceModuleImport = { start: number; end: number; specifier: string }

/** `code` already carries its inline source map, whose VLQ `mappings` are repeated for the
 *  frame's prelude; `imports` index into `code`. */
export type PluginSourceTranspiled =
  | { ok: true; code: string; mappings: string; imports: readonly PluginSourceModuleImport[] }
  | { ok: false; message: string }

export type PluginSourceTranspileRequest = { id: number; relativePath: string; source: string }
export type PluginSourceTranspileResponse = { id: number; result: PluginSourceTranspiled }
