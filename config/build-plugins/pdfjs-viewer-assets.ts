import { createReadStream, cpSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Plugin } from 'vite'

export const PDFJS_VIEWER_ASSET_DIRS = ['cmaps', 'standard_fonts', 'wasm'] as const

function isAssetDirectory(
  value: string | undefined
): value is (typeof PDFJS_VIEWER_ASSET_DIRS)[number] {
  return value !== undefined && PDFJS_VIEWER_ASSET_DIRS.some((directory) => directory === value)
}

function pdfjsRoot(): string {
  return dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
}

function assetPath(root: string, pathname: string): string | undefined {
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
  const directory = parts[0]
  if (parts.length < 2 || !isAssetDirectory(directory)) {
    return undefined
  }
  if (parts.some((part) => part === '.' || part === '..' || part.includes('\\'))) {
    return undefined
  }
  const candidate = resolve(root, ...parts)
  const base = resolve(root, directory)
  const withinBase = relative(base, candidate)
  if (withinBase.length === 0 || withinBase.startsWith('..') || isAbsolute(withinBase)) {
    return undefined
  }
  return candidate
}

function copyAssets(root: string, outputDir: string): void {
  for (const directory of PDFJS_VIEWER_ASSET_DIRS) {
    const source = join(root, directory)
    if (!existsSync(source)) {
      throw new Error(`[pdfjs-viewer-assets] missing ${source}`)
    }
    cpSync(source, join(outputDir, directory), { recursive: true })
  }
}

export function createPdfjsViewerAssetsPlugin(root = pdfjsRoot()): Plugin {
  return {
    name: 'pdfjs-viewer-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        let pathname: string
        try {
          pathname = new URL(request.url ?? '/', 'http://localhost').pathname
        } catch {
          next()
          return
        }
        const filePath = assetPath(root, pathname)
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
        throw new Error('[pdfjs-viewer-assets] output directory is required')
      }
      mkdirSync(options.dir, { recursive: true })
      copyAssets(root, options.dir)
    }
  }
}
