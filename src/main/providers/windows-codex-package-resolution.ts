import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, join, parse, relative, sep } from 'node:path'
import {
  isCanonicalCodexPackageShim,
  resolvePowerShellExternalCommand
} from './windows-powershell-command-resolution'

export type ResolvedWindowsCodexTarget = {
  file: string
  envToDelete: string[]
  env: Record<string, string>
}

type PackageManifest = {
  name?: unknown
  bin?: unknown
  version?: unknown
  optionalDependencies?: unknown
}

type ResolvedCodexPackage = {
  root: string
  manifest: PackageManifest
}

const TRUSTED_CODEX_ENTRYPOINT_SHA256 = new Set([
  '134063e133f0b4244fa3b251acf973d4fe4b4aeeacbdc135211bf480f59f1477'
])

function readPackageManifest(path: string): PackageManifest | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
  } catch {
    return null
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isTrustedCodexJavaScript(path: string): boolean {
  try {
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex')
    return TRUSTED_CODEX_ENTRYPOINT_SHA256.has(hash)
  } catch {
    return false
  }
}

function isExpectedRelativePath(root: string, candidate: string, expected: string): boolean {
  const candidateRelativePath = relative(root, candidate)
  return (
    !isAbsolute(candidateRelativePath) &&
    candidateRelativePath !== '..' &&
    !candidateRelativePath.startsWith(`..${sep}`) &&
    candidateRelativePath.toLowerCase() === expected.toLowerCase()
  )
}

function resolveCodexPackage(commandPath: string): ResolvedCodexPackage | null {
  try {
    const packageRoot = realpathSync(join(dirname(commandPath), 'node_modules', '@openai', 'codex'))
    const manifest = readPackageManifest(join(packageRoot, 'package.json'))
    const bin = manifest?.bin
    if (
      manifest?.name !== '@openai/codex' ||
      !bin ||
      typeof bin !== 'object' ||
      Array.isArray(bin) ||
      (bin as Record<string, unknown>).codex !== 'bin/codex.js'
    ) {
      return null
    }
    const codexJavaScript = realpathSync(join(packageRoot, 'bin', 'codex.js'))
    // Why: direct native launch may bypass only an official entrypoint whose
    // package-manager/env behavior the handoff host deliberately reproduces.
    return isFile(codexJavaScript) &&
      isTrustedCodexJavaScript(codexJavaScript) &&
      isExpectedRelativePath(packageRoot, codexJavaScript, join('bin', 'codex.js'))
      ? { root: packageRoot, manifest }
      : null
  } catch {
    return null
  }
}

function isPnpmOwnedCodexInstall(nodeModulesDir: string, canonicalPackageRoot: string): boolean {
  if (!existsSync(join(nodeModulesDir, '.modules.yaml'))) {
    return false
  }
  try {
    return realpathSync(join(nodeModulesDir, '@openai', 'codex')) === canonicalPackageRoot
  } catch {
    return false
  }
}

function hasPnpmOwnedCodexInstall(packageRoot: string, commandPath: string): boolean {
  for (const start of new Set([packageRoot, dirname(commandPath)])) {
    const filesystemRoot = parse(start).root
    for (let current = start; ; current = dirname(current)) {
      if (isPnpmOwnedCodexInstall(join(current, 'node_modules'), packageRoot)) {
        return true
      }
      if (current === filesystemRoot) {
        break
      }
    }
  }
  return false
}

function getManagedPackageEnv(
  packageRoot: string,
  commandPath: string,
  env: Record<string, string>
): Pick<ResolvedWindowsCodexTarget, 'env' | 'envToDelete'> {
  const managedKeys = ['CODEX_MANAGED_BY_NPM', 'CODEX_MANAGED_BY_PNPM', 'CODEX_MANAGED_BY_BUN']
  const userAgent = env.npm_config_user_agent ?? ''
  const npmExecPath = env.npm_execpath ?? ''
  const isBunInstall =
    /\.bun[\\/]install[\\/]global/i.test(packageRoot) ||
    /\.bun[\\/]install[\\/]global/i.test(commandPath)
  const managedKey =
    /\bbun\//.test(userAgent) || npmExecPath.toLowerCase().includes('bun') || isBunInstall
      ? 'CODEX_MANAGED_BY_BUN'
      : hasPnpmOwnedCodexInstall(packageRoot, commandPath)
        ? 'CODEX_MANAGED_BY_PNPM'
        : 'CODEX_MANAGED_BY_NPM'
  return {
    envToDelete: managedKeys,
    env: {
      CODEX_MANAGED_PACKAGE_ROOT: packageRoot,
      [managedKey]: '1'
    }
  }
}

function resolveCodexVendorRoot(
  codexPackage: ResolvedCodexPackage,
  packageName: string
): string | null {
  let packageJsonPath: string
  try {
    packageJsonPath = createRequire(join(codexPackage.root, 'package.json')).resolve(
      `${packageName}/package.json`
    )
  } catch {
    return join(codexPackage.root, 'vendor')
  }
  const platformPackageRoot = realpathSync(dirname(packageJsonPath))
  const manifest = readPackageManifest(join(platformPackageRoot, 'package.json'))
  const optionalDependencies = codexPackage.manifest.optionalDependencies
  const aliasedDependency =
    optionalDependencies &&
    typeof optionalDependencies === 'object' &&
    !Array.isArray(optionalDependencies)
      ? (optionalDependencies as Record<string, unknown>)[packageName]
      : undefined
  const isDirectPackage = manifest?.name === packageName
  const isNpmAlias =
    manifest?.name === '@openai/codex' &&
    typeof manifest.version === 'string' &&
    aliasedDependency === `npm:@openai/codex@${manifest.version}`
  return isDirectPackage || isNpmAlias ? join(platformPackageRoot, 'vendor') : null
}

function resolvePackagedCodexExecutable(
  commandPath: string,
  arch: string,
  env: Record<string, string>
): ResolvedWindowsCodexTarget | null {
  if (!isCanonicalCodexPackageShim(commandPath)) {
    return null
  }
  const codexPackage = resolveCodexPackage(commandPath)
  const target =
    arch === 'x64'
      ? { packageName: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' }
      : arch === 'arm64'
        ? { packageName: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' }
        : null
  if (!codexPackage || !target) {
    return null
  }
  try {
    const vendorRoot = resolveCodexVendorRoot(codexPackage, target.packageName)
    if (!vendorRoot) {
      return null
    }
    const executable = realpathSync(join(vendorRoot, target.triple, 'bin', 'codex.exe'))
    if (
      !isFile(executable) ||
      !isExpectedRelativePath(vendorRoot, executable, join(target.triple, 'bin', 'codex.exe'))
    ) {
      return null
    }
    return {
      file: executable,
      ...getManagedPackageEnv(codexPackage.root, commandPath, env)
    }
  } catch {
    return null
  }
}

export function resolveWindowsCodexTarget(args: {
  env: Record<string, string>
  arch: string
  pathEnv: string | null | undefined
  pathExt: string | null | undefined
}): ResolvedWindowsCodexTarget | null {
  const commandPath = resolvePowerShellExternalCommand({
    command: 'codex',
    pathEnv: args.pathEnv,
    pathExt: args.pathExt
  })
  if (!commandPath || !isAbsolute(commandPath) || !existsSync(commandPath)) {
    return null
  }
  const extension = extname(commandPath).toLowerCase()
  if (extension === '.exe') {
    return { file: commandPath, envToDelete: [], env: {} }
  }
  return extension === '.cmd' || extension === '.ps1'
    ? resolvePackagedCodexExecutable(commandPath, args.arch, args.env)
    : null
}
