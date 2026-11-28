/** Messages between main and the plugin source transpile worker; no transpiler imports here. */

/** Part of every cache key; a test pins it to the bundled sucrase version. */
export const PLUGIN_SOURCE_TRANSPILER_ID = 'sucrase@3.35.1'

export type PluginSourceModuleImport = { start: number; end: number; specifier: string }

/** `code` already carries its inline source map, whose VLQ `mappings` are repeated for the
 *  frame's prelude; `imports` index into `code`. */
export type PluginSourceTranspiled =
  | { ok: true; code: string; mappings: string; imports: readonly PluginSourceModuleImport[] }
  // `transient`: the client's budget timeout or worker crash, worth retrying later.
  | { ok: false; message: string; transient?: true }

export type PluginSourceTranspileRequest = { id: number; relativePath: string; source: string }
export type PluginSourceTranspileResponse = { id: number; result: PluginSourceTranspiled }
/** Posted once after the worker's modules load, so the client's budget leaves out cold start. */
export type PluginSourceTranspileWorkerReady = { ready: true }
export type PluginSourceTranspileWorkerMessage =
  | PluginSourceTranspileResponse
  | PluginSourceTranspileWorkerReady
