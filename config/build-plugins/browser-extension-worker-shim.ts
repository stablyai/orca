import { resolve } from 'node:path'
import { build, type Plugin } from 'vite'
import {
  BROWSER_EXTENSION_CONTENT_SCRIPT_FILE,
  BROWSER_EXTENSION_WORKER_SHIM_FILE
} from '../../src/shared/browser-extension-worker-api'

type BundledScript = { code: string; moduleIds: string[] }

const WORKER_SHIM = {
  entry: 'src/preload/browser-extension-worker-shim.ts',
  fileName: BROWSER_EXTENSION_WORKER_SHIM_FILE
}
const CONTENT_SCRIPT = {
  entry: 'src/preload/browser-extension-content-script-api.ts',
  fileName: BROWSER_EXTENSION_CONTENT_SCRIPT_FILE
}

/**
 * One dependency-free script, valid for importScripts, as a side-effect module import and as a
 * content script. Why a separate build: as a second Rollup entry its modules would land in a chunk
 * shared with the sandboxed preload, which cannot load chunks.
 */
async function bundleScript(entry: string, fileName: string): Promise<BundledScript> {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      target: 'es2022',
      lib: {
        entry: resolve(entry),
        formats: ['iife'],
        name: 'orcaBrowserExtensionScript',
        fileName: () => fileName
      }
    }
  })
  for (const output of Array.isArray(result) ? result : [result]) {
    if (!('output' in output)) {
      continue
    }
    for (const chunk of output.output) {
      if (chunk.type === 'chunk' && chunk.isEntry) {
        return { code: chunk.code, moduleIds: chunk.moduleIds }
      }
    }
  }
  throw new Error(`The ${fileName} build produced no script`)
}

export function bundleBrowserExtensionWorkerShim(): Promise<BundledScript> {
  return bundleScript(WORKER_SHIM.entry, WORKER_SHIM.fileName)
}

export function bundleBrowserExtensionContentScript(): Promise<BundledScript> {
  return bundleScript(CONTENT_SCRIPT.entry, CONTENT_SCRIPT.fileName)
}

/** Emits the worker shim and content script next to the main bundle, where the loader copies them from. */
export function createBrowserExtensionWorkerShimPlugin(): Plugin {
  return {
    name: 'orca-browser-extension-worker-shim',
    async buildStart() {
      for (const { entry, fileName } of [WORKER_SHIM, CONTENT_SCRIPT]) {
        const { code, moduleIds } = await bundleScript(entry, fileName)
        for (const id of moduleIds) {
          this.addWatchFile(id)
        }
        this.emitFile({ type: 'asset', fileName, source: code })
      }
    }
  }
}
