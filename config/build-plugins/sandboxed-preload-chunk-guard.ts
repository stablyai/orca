import type { Plugin, Rollup } from 'vite'

// Sandboxed webview preloads can only require('electron'); one shared-chunk require fails the whole preload.
export const SANDBOXED_PRELOAD_ENTRY_NAMES = [
  'browser-guest-preload',
  'doc-preview-link-preload'
] as const

/** Throws unless every sandboxed preload entry in the build is one self-contained chunk. */
export function assertSandboxedPreloadsAreSelfContained(chunks: Rollup.OutputChunk[]): void {
  for (const name of SANDBOXED_PRELOAD_ENTRY_NAMES) {
    // Partial builds (tests, CLI) leave some preloads out; there is nothing to check then.
    const entry = chunks.find((chunk) => chunk.isEntry && chunk.name === name)
    if (!entry) {
      continue
    }
    const shared = [...entry.imports, ...entry.dynamicImports]
    if (shared.length > 0) {
      throw new Error(
        `[sandboxed-preload-chunk-guard] "${name}" imports ${shared.join(', ')}. Sandboxed preloads ` +
          `can only require("electron"), so the guest loads none of it. Keep runtime imports from ` +
          `src/shared and src/main out of its module graph.`
      )
    }
  }
}

export function createSandboxedPreloadChunkGuardPlugin(): Plugin {
  return {
    name: 'orca-sandboxed-preload-chunk-guard',
    generateBundle(_options, bundle) {
      assertSandboxedPreloadsAreSelfContained(
        Object.values(bundle).filter((item): item is Rollup.OutputChunk => item.type === 'chunk')
      )
    }
  }
}
