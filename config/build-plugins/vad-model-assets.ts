import { createReadStream, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join } from 'node:path'
import type { Plugin } from 'vite'

export const VAD_ASSET_DIRECTORY = 'vad'

// onnxruntime-web's exports map hides package.json, so both roots come from the
// resolved entry points (dist/index.js and dist/ort.min.js respectively).
function vadAssetSources(): Record<string, string> {
  const require = createRequire(import.meta.url)
  const vadWebDist = dirname(require.resolve('@ricky0123/vad-web'))
  const onnxDist = dirname(require.resolve('onnxruntime-web'))
  return {
    'silero_vad_v5.onnx': join(vadWebDist, 'silero_vad_v5.onnx'),
    'ort-wasm-simd-threaded.wasm': join(onnxDist, 'ort-wasm-simd-threaded.wasm')
  }
}

// The exact-filename whitelist is the path-safety guard: nothing else under the
// directory prefix is ever servable, so traversal sequences have nothing to reach.
function assetPath(sources: Record<string, string>, pathname: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return undefined
  }
  if (decoded.includes('\0') || decoded.includes('\\')) {
    return undefined
  }
  const parts = decoded.split('/').filter(Boolean)
  if (parts.length !== 2 || parts[0] !== VAD_ASSET_DIRECTORY) {
    return undefined
  }
  return sources[parts[1]]
}

function copyAssets(sources: Record<string, string>, outputDir: string): void {
  const targetDir = join(outputDir, VAD_ASSET_DIRECTORY)
  mkdirSync(targetDir, { recursive: true })
  for (const [filename, source] of Object.entries(sources)) {
    if (!existsSync(source)) {
      throw new Error(`[vad-model-assets] missing ${source}`)
    }
    copyFileSync(source, join(targetDir, filename))
  }
}

export function createVadModelAssetsPlugin(sources: Record<string, string> = vadAssetSources()): Plugin {
  return {
    name: 'vad-model-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        let pathname: string
        try {
          pathname = new URL(request.url ?? '/', 'http://localhost').pathname
        } catch {
          next()
          return
        }
        const filePath = assetPath(sources, pathname)
        if (!filePath || (request.method !== 'GET' && request.method !== 'HEAD')) {
          next()
          return
        }
        let size: number
        try {
          size = statSync(filePath).size
        } catch {
          next()
          return
        }
        if (response.destroyed) {
          return
        }
        response.statusCode = 200
        response.setHeader('Content-Length', size)
        response.setHeader(
          'Content-Type',
          extname(filePath) === '.wasm' ? 'application/wasm' : 'application/octet-stream'
        )
        if (request.method === 'HEAD') {
          response.end()
          return
        }
        const stream = createReadStream(filePath)
        const stopReading = (): void => {
          stream.destroy()
        }
        response.once('close', stopReading)
        response.once('error', stopReading)
        stream.once('close', () => {
          response.off('close', stopReading)
          response.off('error', stopReading)
        })
        stream.once('error', () => response.destroy())
        stream.pipe(response)
      })
    },
    writeBundle(options) {
      if (!options.dir) {
        throw new Error('[vad-model-assets] output directory is required')
      }
      mkdirSync(options.dir, { recursive: true })
      copyAssets(sources, options.dir)
    }
  }
}
