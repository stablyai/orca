const { existsSync, readFileSync, realpathSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')
const { builtinModules, createRequire } = require('node:module')

const projectDir = resolve(__dirname, '..')
const requireFromProject = createRequire(join(projectDir, 'package.json'))

const PACKAGED_RUNTIME_PACKAGE_ROOTS = [
  '@electron-toolkit/utils',
  '@linear/sdk',
  'electron-updater',
  'node-pty',
  'posthog-node',
  'qrcode',
  'ssh2',
  'tweetnacl',
  'ws',
  'yaml',
  'zod'
]

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`)
])

function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/')
    return scope && name ? `${scope}/${name}` : specifier
  }
  return specifier.split('/')[0]
}

function isPackagedExternalSpecifier(specifier) {
  return (
    !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    specifier !== 'electron' &&
    !NODE_BUILTINS.has(specifier)
  )
}

function resolvePackageJsonPath(packageName, fromDir = projectDir) {
  try {
    return requireFromProject.resolve(`${packageName}/package.json`, { paths: [fromDir] })
  } catch {
    const entryPath = requireFromProject.resolve(packageName, { paths: [fromDir] })
    let dir = dirname(entryPath)
    while (dir !== dirname(dir)) {
      const packageJsonPath = join(dir, 'package.json')
      if (existsSync(packageJsonPath)) {
        return packageJsonPath
      }
      dir = dirname(dir)
    }
    throw new Error(`Could not find package.json for ${packageName}`)
  }
}

function readPackage(packageName, fromDir = projectDir) {
  const packageJsonPath = resolvePackageJsonPath(packageName, fromDir)
  const packageDir = realpathSync(dirname(packageJsonPath))
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  return {
    name: packageJson.name ?? packageName,
    packageDir,
    dependencies: Object.keys(packageJson.dependencies ?? {})
  }
}

function collectPackagedRuntimePackages() {
  const packages = new Map()
  const visit = (packageName, fromDir = projectDir) => {
    if (packageName === 'electron' || packages.has(packageName)) {
      return
    }

    const packageInfo = readPackage(packageName, fromDir)
    if (packages.has(packageInfo.name)) {
      return
    }
    packages.set(packageInfo.name, packageInfo.packageDir)

    for (const dependencyName of packageInfo.dependencies) {
      visit(dependencyName, packageInfo.packageDir)
    }
  }

  for (const packageName of PACKAGED_RUNTIME_PACKAGE_ROOTS) {
    visit(packageName)
  }

  return [...packages.entries()].sort(([left], [right]) => left.localeCompare(right))
}

function createPackagedRuntimeNodeModuleResources() {
  return collectPackagedRuntimePackages().map(([packageName, packageDir]) => ({
    from: packageDir,
    to: join('node_modules', ...packageName.split('/'))
  }))
}

module.exports = {
  PACKAGED_RUNTIME_PACKAGE_ROOTS,
  createPackagedRuntimeNodeModuleResources,
  isPackagedExternalSpecifier,
  packageNameFromSpecifier
}
