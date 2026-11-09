import { describe, expect, it } from 'vitest'
import { createSandboxedScriptBundlesPlugin } from '../../../build-plugins/sandboxed-script-bundles'

/** Runs the plugin's real bundling and returns the assets it emitted, by file name. */
async function runBuildStart(input: Record<string, string>): Promise<Map<string, string>> {
  // Typed as unknown so the hook takes this minimal context instead of a full PluginContext.
  const hook: unknown = createSandboxedScriptBundlesPlugin().buildStart
  if (typeof hook !== 'function') {
    throw new Error('Expected buildStart hook')
  }
  const emitted = new Map<string, string>()
  // Rollup's this.error throws, which aborts the build.
  const context = {
    error: (message: string) => {
      throw new Error(message)
    },
    addWatchFile: () => {},
    emitFile: ({ fileName, source }: { fileName: string; source: string }) => {
      emitted.set(fileName, source)
      return fileName
    }
  }
  await hook.call(context, { input })
  return emitted
}

describe('sandboxed script bundles plugin', () => {
  it('bundles the extension frame preload as standalone CommonJS', async () => {
    const emitted = await runBuildStart({ index: 'src/main/index.ts' })

    expect(emitted.get('browser-extension-preload.js')).toMatch(/require\("electron"\)/)
  })

  it('fails the build when a sandboxed bundle is also a main-build entry', async () => {
    await expect(
      runBuildStart({
        index: 'src/main/index.ts',
        'browser-extension-preload': 'src/preload/browser-extension-preload.ts'
      })
    ).rejects.toThrow(
      'browser-extension-preload.js is a sandboxed bundle; remove it from the main build entries'
    )
  })
})
