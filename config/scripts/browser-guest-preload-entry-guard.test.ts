import { describe, expect, it } from 'vitest'
import type { Plugin, Rollup } from 'vite'
import { createBrowserGuestPreloadEntryGuardPlugin } from '../build-plugins/browser-guest-preload-entry-guard'

function entry(imports: string[] = [], dynamicImports: string[] = []): Rollup.OutputChunk {
  return {
    type: 'chunk',
    name: 'browser-guest-preload',
    fileName: 'browser-guest-preload.js',
    isEntry: true,
    imports,
    dynamicImports
  } as Rollup.OutputChunk
}

function runBuildStart(plugin: Plugin, input: Rollup.InputOption): void {
  const hook = plugin.buildStart
  if (typeof hook !== 'function') {
    throw new Error('Expected buildStart hook')
  }
  hook.call({} as never, { input } as Rollup.NormalizedInputOptions)
}

function runGenerateBundle(plugin: Plugin, output?: Rollup.OutputChunk): void {
  const hook = plugin.generateBundle
  if (typeof hook !== 'function') {
    throw new Error('Expected generateBundle hook')
  }
  hook.call(
    {} as never,
    {} as Rollup.NormalizedOutputOptions,
    output ? { [output.fileName]: output } : {}
  )
}

describe('browser guest preload entry guard', () => {
  it('accepts the named browser guest preload input', () => {
    const plugin = createBrowserGuestPreloadEntryGuardPlugin()

    expect(() =>
      runBuildStart(plugin, { 'browser-guest-preload': 'src/preload/browser-guest.ts' })
    ).not.toThrow()
  })

  it.each([
    ['a string input', 'src/preload/browser-guest.ts'],
    ['an input array', ['src/main/index.ts', 'src/preload/browser-guest.ts']],
    ['an input map without the browser guest preload', { main: 'src/main/index.ts' }]
  ])('rejects %s', (_label, input) => {
    const plugin = createBrowserGuestPreloadEntryGuardPlugin()

    expect(() => runBuildStart(plugin, input)).toThrow(/is not a Rollup input/)
  })

  it('accepts a standalone browser guest preload', () => {
    const plugin = createBrowserGuestPreloadEntryGuardPlugin()

    expect(() => runGenerateBundle(plugin, entry())).not.toThrow()
  })

  it('rejects a bundle without the browser guest preload entry', () => {
    const plugin = createBrowserGuestPreloadEntryGuardPlugin()

    expect(() => runGenerateBundle(plugin)).toThrow(/missing built entry/)
  })

  it('rejects browser guest preload dependencies', () => {
    const plugin = createBrowserGuestPreloadEntryGuardPlugin()

    expect(() => runGenerateBundle(plugin, entry(['chunks/browser-anti-detection.js']))).toThrow(
      /must be standalone.*browser-anti-detection/
    )
  })

  it('rejects browser guest preload dynamic dependencies', () => {
    const plugin = createBrowserGuestPreloadEntryGuardPlugin()

    expect(() =>
      runGenerateBundle(plugin, entry([], ['chunks/browser-anti-detection.js']))
    ).toThrow(/must be standalone.*browser-anti-detection/)
  })
})
