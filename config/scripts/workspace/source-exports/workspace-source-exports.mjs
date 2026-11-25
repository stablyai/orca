import { existsSync, globSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse } from 'yaml'

export function workspacePackageManifests(root) {
  const policy = join(root, 'pnpm-workspace.yaml')
  if (!existsSync(policy)) {
    return []
  }
  const { packages = [] } = parse(readFileSync(policy, 'utf8')) ?? {}
  if (!Array.isArray(packages) || packages.some((pattern) => typeof pattern !== 'string')) {
    throw new Error('Workspace package patterns are unavailable')
  }
  const manifests = (patterns) =>
    patterns.map((pattern) => `${pattern.replace(/\/$/, '')}/package.json`)
  return globSync(manifests(packages.filter((pattern) => !pattern.startsWith('!'))), {
    cwd: root,
    exclude: manifests(
      packages.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1))
    )
  })
    .map((manifest) => manifest.split(sep).join('/'))
    .sort()
}

function sourceTarget(root, manifest, target) {
  if (
    typeof target !== 'string' ||
    !target.startsWith('./') ||
    target.includes('\\') ||
    target.split('/').some((segment) => ['..', 'node_modules', 'dist'].includes(segment)) ||
    !/\.(?:ts|tsx|js|mjs|cjs|json)$/.test(target) ||
    target.endsWith('.d.ts')
  ) {
    throw new Error(`Invalid orca-source export in ${manifest}`)
  }
  const packageDir = realpathSync(join(root, dirname(manifest)))
  const path = realpathSync(resolve(packageDir, target))
  const withinPackage = relative(packageDir, path)
  if (withinPackage.startsWith(`..${sep}`) || isAbsolute(withinPackage)) {
    throw new Error(`orca-source export escapes ${manifest}`)
  }
  return { path, file: relative(root, path).split(sep).join('/'), manifest }
}

function packageExports(manifest, metadata) {
  const exports = metadata.exports
  if (!exports || typeof exports !== 'object' || Array.isArray(exports)) {
    return []
  }
  const entries = Object.keys(exports).some((key) => key.startsWith('.'))
    ? Object.entries(exports)
    : [['.', exports]]
  if (entries.some(([key]) => key.includes('*') || (key !== '.' && !key.startsWith('./')))) {
    throw new Error(`Workspace source exports must name public entry points: ${manifest}`)
  }
  return entries
}

export function createWorkspaceSourceResolver(root = process.cwd()) {
  root = realpathSync(root)
  const packages = new Map()
  const sources = new Map()
  for (const manifest of workspacePackageManifests(root)) {
    const metadata = JSON.parse(readFileSync(join(root, manifest), 'utf8'))
    if (typeof metadata.name !== 'string' || packages.has(metadata.name)) {
      throw new Error(`Missing or duplicate workspace package name: ${manifest}`)
    }
    packages.set(metadata.name, { manifest, native: manifest.startsWith('native/') })
    for (const [key, conditions] of packageExports(manifest, metadata)) {
      if (
        !conditions ||
        typeof conditions !== 'object' ||
        !Object.hasOwn(conditions, 'orca-source')
      ) {
        continue
      }
      const specifier = metadata.name + (key === '.' ? '' : key.slice(1))
      sources.set(specifier, sourceTarget(root, manifest, conditions['orca-source']))
    }
  }
  return {
    esbuildAliases: Object.fromEntries(
      [...sources].map(([specifier, source]) => [specifier, source.path])
    ),
    aliases: [...sources].map(([specifier, source]) => ({
      find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
      replacement: source.path
    })),
    resolve(specifier) {
      const name = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0]
      const workspace = packages.get(name)
      if (sources.has(specifier)) {
        return sources.get(specifier)
      }
      if (workspace?.native || (!workspace && !specifier.startsWith('@orca/'))) {
        return null
      }
      throw new Error(`No public orca-source export for ${specifier}`)
    }
  }
}
