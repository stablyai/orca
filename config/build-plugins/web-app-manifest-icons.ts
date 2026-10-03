import { extname } from 'node:path'
import type { Plugin } from 'vite'

const WEB_MANIFEST_SUFFIX = '.webmanifest'

export interface WebManifestIcon {
  src?: string
  [key: string]: unknown
}

export interface WebManifestBundleAsset {
  type: string
  source?: string | Uint8Array
}

export type WebManifestBundle = Record<string, WebManifestBundleAsset>

function emittedIconNames(emittedFileNames: Iterable<string>, manifestFileName: string): string[] {
  const directory = manifestFileName.slice(0, manifestFileName.lastIndexOf('/') + 1)
  const names: string[] = []
  for (const fileName of emittedFileNames) {
    if (fileName.startsWith(directory)) {
      names.push(fileName.slice(directory.length))
    }
  }
  return names
}

function findEmittedIcon(declaredSrc: string, emittedNames: string[]): string | undefined {
  const declaredName = declaredSrc.replace(/^\.\//, '')
  const extension = extname(declaredName)
  if (extension.length === 0) {
    return undefined
  }
  const stemPrefix = `${declaredName.slice(0, -extension.length)}-`
  return emittedNames.find(
    (name) => name.startsWith(stemPrefix) && name.endsWith(extension) && name !== declaredName
  )
}

export function resolveWebManifestIcons(
  icons: WebManifestIcon[],
  emittedFileNames: Iterable<string>,
  manifestFileName: string
): WebManifestIcon[] {
// Why beside the manifest: Vite hashes HTML-referenced assets, so `./web-icon-192.png` would ship
// next to `web-icon-192-<hash>.png` and 404.
const emittedNames = emittedIconNames(emittedFileNames, manifestFileName)

  for (const icon of icons) {
    const declaredSrc = icon.src ?? ''
    const emitted = findEmittedIcon(declaredSrc, emittedNames)
    if (!emitted) {
      throw new Error(
        `[web-app-manifest-icons] ${manifestFileName} declares icon ` +
          `${declaredSrc || '<unnamed>'}, but the build emitted no matching asset beside it`
      )
    }
    icon.src = `./${emitted}`
  }

  return icons
}

function readAssetSource(source: string | Uint8Array): string {
  return typeof source === 'string' ? source : Buffer.from(source).toString('utf8')
}

export function rewriteWebAppManifests(bundle: WebManifestBundle): void {
  const emittedFileNames = Object.keys(bundle)

  for (const fileName of emittedFileNames) {
    const asset = bundle[fileName]
    if (!asset || asset.type !== 'asset' || !fileName.endsWith(WEB_MANIFEST_SUFFIX)) {
      continue
    }
    const parsed: unknown = JSON.parse(readAssetSource(asset.source ?? ''))
    if (typeof parsed !== 'object' || parsed === null || !('icons' in parsed)) {
      throw new Error(`[web-app-manifest-icons] ${fileName} does not declare an icon array`)
    }
    const icons: unknown = parsed.icons
    if (!Array.isArray(icons)) {
      throw new Error(`[web-app-manifest-icons] ${fileName} does not declare an icon array`)
    }
    resolveWebManifestIcons(icons, emittedFileNames, fileName)
    asset.source = `${JSON.stringify(parsed, null, 2)}\n`
  }
}

export function createWebAppManifestIconsPlugin(): Plugin {
  return {
    name: 'web-app-manifest-icons',
    generateBundle(_options, bundle) {
      rewriteWebAppManifests(bundle)
    }
  }
}
