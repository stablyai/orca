import { describe, expect, it } from 'vitest'
import type { Plugin, Rollup } from 'vite'
import { createBrowserGuestPreloadEntryGuardPlugin } from '../build-plugins/browser-guest-preload-entry-guard'

function entry(imports: string[] = []): Rollup.OutputChunk {
  return {
    type: 'chunk',
    name: 'browser-guest-preload',
    fileName: 'browser-guest-preload.js',
    isEntry: true,
    imports,
    dynamicImports: []
  } as Rollup.OutputChunk
}

function runGenerateBundle(plugin: Plugin, output: Rollup.OutputChunk): void {
  const hook = plugin.generateBundle
  if (typeof hook !== 'function') {
    throw new Error('Expected generateBundle hook')
  }
  hook.call({} as never, {} as Rollup.NormalizedOutputOptions, {
    [output.fileName]: output
  })
}

describe('browser guest preload entry guard', () => {
  it('accepts a standalone browser guest preload', () => {
    const plugin = createBrowserGuestPreloadEntryGuardPlugin()

    expect(() => runGenerateBundle(plugin, entry())).not.toThrow()
  })

  it('rejects browser guest preload dependencies', () => {
    const plugin = createBrowserGuestPreloadEntryGuardPlugin()

    expect(() => runGenerateBundle(plugin, entry(['chunks/browser-anti-detection.js']))).toThrow(
      /must be standalone.*browser-anti-detection/
    )
  })
})
