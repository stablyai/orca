import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { generateManifest } from 'material-icon-theme'

const ROOT = resolve(import.meta.dirname, '..', '..')
const OUT_DIR = resolve(ROOT, 'src/renderer/public/file-icons')
const MANIFEST_PATH = resolve(ROOT, 'src/renderer/src/lib/material-file-icons-manifest.json')
const ICONS_SRC = resolve(ROOT, 'node_modules/material-icon-theme/icons')
const LICENSE_SRC = resolve(ROOT, 'node_modules/material-icon-theme/LICENSE')
const LICENSE_OUT = resolve(OUT_DIR, 'LICENSE.material-icon-theme.txt')

/** Keep optional manifest mappings from producing invalid asset names. */
function addIcon(referencedIcons, name) {
  if (typeof name === 'string' && name.length > 0) {
    referencedIcons.add(name)
  }
}

/** Condense VS Code's manifest to the path lookups Orca can perform at runtime. */
function createManifest() {
  const manifest = generateManifest({
    activeIconPack: 'react',
    folders: { theme: 'specific' }
  })

  const referencedIcons = new Set()

  addIcon(referencedIcons, manifest.file)

  for (const icon of Object.values(manifest.fileNames ?? {})) {
    addIcon(referencedIcons, icon)
  }
  for (const icon of Object.values(manifest.fileExtensions ?? {})) {
    addIcon(referencedIcons, icon)
  }
  for (const icon of Object.values(manifest.languageIds ?? {})) {
    addIcon(referencedIcons, icon)
  }

  const condensed = {
    fileNames: manifest.fileNames ?? {},
    fileExtensions: manifest.fileExtensions ?? {},
    defaultIcon: manifest.file ?? 'file'
  }

  // Why: material-icon-theme expects VS Code language IDs. Orca only has paths,
  // so fold common language IDs into extension matches during generation.
  const languageIdExtensionMap = {
    diff: 'diff',
    html: 'html',
    js: 'javascript',
    m: 'matlab',
    patch: 'diff',
    php: 'php',
    tex: 'tex',
    ts: 'typescript',
    yaml: 'yaml',
    yml: 'yaml'
  }

  for (const [ext, icon] of Object.entries(languageIdExtensionMap)) {
    if (!condensed.fileExtensions[ext]) {
      condensed.fileExtensions[ext] = icon
      addIcon(referencedIcons, icon)
    }
  }

  return { manifest: condensed, referencedIcons }
}

/** Check assets in so packaged and remote sessions never depend on runtime node_modules access. */
function run() {
  const { manifest, referencedIcons } = createManifest()

  if (existsSync(OUT_DIR)) {
    rmSync(OUT_DIR, { recursive: true })
  }
  mkdirSync(OUT_DIR, { recursive: true })
  cpSync(LICENSE_SRC, LICENSE_OUT)
  chmodSync(LICENSE_OUT, 0o644)

  const copiedIcons = new Set()
  for (const iconName of referencedIcons) {
    const sourcePath = resolve(ICONS_SRC, `${iconName}.svg`)
    const targetPath = resolve(OUT_DIR, `${iconName}.svg`)
    if (!existsSync(sourcePath)) {
      continue
    }
    cpSync(sourcePath, targetPath)
    chmodSync(targetPath, 0o644)
    copiedIcons.add(iconName)
  }

  // Why: upstream maps some patterns to icons it does not ship. Keeping those
  // entries would resolve to a 404 and render a blank <img>, which bypasses the
  // classic-icon fallback that only triggers on an unmapped path.
  let pruned = 0
  for (const group of [manifest.fileNames, manifest.fileExtensions]) {
    for (const [key, iconName] of Object.entries(group)) {
      if (!copiedIcons.has(iconName)) {
        delete group[key]
        pruned += 1
      }
    }
  }

  if (!copiedIcons.has(manifest.defaultIcon)) {
    throw new Error(`Default icon asset is missing: ${manifest.defaultIcon}.svg`)
  }

  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(
    [
      `Generated file icons: ${copiedIcons.size} SVGs copied`,
      `${pruned} unshipped mapping(s) pruned`,
      `${Object.keys(manifest.fileNames).length} file names`,
      `${Object.keys(manifest.fileExtensions).length} extensions`
    ].join(', ')
  )
}

run()
