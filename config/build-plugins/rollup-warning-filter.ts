import type { Rollup } from 'vite'

// Real boot-graph size budgets are enforced by verifyRendererBootGraph().
export const RENDERER_CHUNK_SIZE_WARNING_LIMIT_KB = 5000

// Lazy cycle-breakers and unit-test side-effect guards intentionally coexist with static importers in full bundles.
export const ignoreIneffectiveDynamicImport: Rollup.WarningHandlerWithDefault = (warning, warn) => {
  if (warning.code !== 'INEFFECTIVE_DYNAMIC_IMPORT') {
    warn(warning)
  }
}
