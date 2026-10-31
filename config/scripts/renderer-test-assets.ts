import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizePath, type Plugin } from 'vite'

export function rendererTestAssets(
  additionalAssets: readonly { url: URL; contentType: string }[] = []
): Plugin {
  const directory = fileURLToPath(new URL('../../src/renderer/src/i18n/locales/', import.meta.url))
  const filesById = new Map<string, { file: string; contentType: string }>()
  const idsByPath = new Map<string, string>()
  const assets = [
    ...readdirSync(directory)
      .filter((filename) => /^[A-Za-z-]+\.json$/.test(filename))
      .map((filename) => ({ file: join(directory, filename), contentType: 'application/json' })),
    ...additionalAssets.map(({ url, contentType }) => ({ file: fileURLToPath(url), contentType }))
  ]
  for (const asset of assets) {
    const id = `\0renderer-test-asset:${filesById.size}.js`
    filesById.set(id, asset)
    idsByPath.set(`${normalizePath(asset.file)}?url`, id)
  }
  return {
    name: 'renderer-test-assets',
    enforce: 'pre',
    resolveId(source, importer) {
      if (filesById.has(source)) {
        return source
      }
      if (!source.endsWith('?url')) {
        return null
      }
      const file = importer ? resolve(dirname(importer.split('?')[0]), source) : source
      return idsByPath.get(normalizePath(file)) ?? null
    },
    load(id) {
      const asset = filesById.get(id)
      if (!asset) {
        return null
      }
      // Virtual modules retain real fetch(data:) parsing without exposing files outside the test root.
      const content = readFileSync(asset.file).toString('base64')
      return `export default ${JSON.stringify(`data:${asset.contentType};base64,${content}`)}`
    }
  }
}
