import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

const FAVICON_FILES = [
  { filename: 'favicon.ico', source: resolve('resources/build/icon.ico') },
  { filename: 'favicon.png', source: resolve('resources/build/icon.png') }
] as const

// Why: serve-mode browsers request /favicon.ico automatically. Copy the
// desktop icon beside web-index.html so the static handler serves it in
// dev (`out/web`) and packaged (`app.asar/.../out/web`) runs without a
// separate extraResources entry.
export function createWebFaviconPlugin(): Plugin {
  let outputDir: string | undefined
  return {
    name: 'orca-web-favicon',
    apply: 'build',
    outputOptions(outputOptions) {
      if (outputOptions.dir) {
        outputDir = outputOptions.dir
      }
      return outputOptions
    },
    closeBundle() {
      if (!outputDir) {
        return
      }
      for (const { filename, source } of FAVICON_FILES) {
        try {
          copyFileSync(source, resolve(outputDir, filename))
        } catch {}
      }
    }
  }
}
