import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { findDynamicVcRuntimeImports, readPeImportedDllNames } from './windows-pe-imports.mjs'

// Why explicit triples: both architectures cross-compile from one x64 runner.
const RUST_TARGETS = {
  x64: 'x86_64-pc-windows-msvc',
  arm64: 'aarch64-pc-windows-msvc'
}

export function windowsRustExecutableFingerprint(inputPaths, version) {
  const hash = createHash('sha256').update(version)
  for (const inputPath of inputPaths) {
    hash.update('\0').update(readFileSync(inputPath))
  }
  return hash.digest('hex')
}

export function shouldReuseCompiledWindowsRustExecutable(outputPath, fingerprint) {
  const fingerprintPath = `${outputPath}.sha256`
  return (
    existsSync(outputPath) &&
    existsSync(fingerprintPath) &&
    readFileSync(fingerprintPath, 'utf8') === fingerprint
  )
}

// PE stores four numeric version fields; prerelease survives only in free-form ProductVersion.
export function windowsRustExecutableFileVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version ?? '')
  if (!match || match.slice(1).some((part) => Number(part) > 65534)) {
    throw new Error(`Invalid Windows executable version: ${version}`)
  }
  return `${match.slice(1).join('.')}.0`
}

export function windowsRustExecutableTarget(arch) {
  if (arch === undefined) {
    return null
  }
  const target = RUST_TARGETS[arch]
  if (!target) {
    throw new Error(`Unsupported Windows executable architecture: ${arch}`)
  }
  return target
}

// Reuse unchanged std-only Cargo build; require output with no VC++ Redistributable dependency.
export function compileWindowsRustExecutable({
  repoRoot,
  crateRoot,
  binName,
  label,
  fingerprintInputs,
  arch,
  outputPath,
  buildEnv
}) {
  if (process.platform !== 'win32') {
    // Missing output must fail: electron-builder otherwise treats skipped native build as successful packaging.
    throw new Error(`${label} compilation requires a Windows host; refusing to package without it.`)
  }
  const manifestPath = join(crateRoot, 'Cargo.toml')
  const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  // Throws on a version the PE cannot represent, before anything is compiled.
  windowsRustExecutableFileVersion(version)
  const rustTarget = windowsRustExecutableTarget(arch)
  const fingerprint = windowsRustExecutableFingerprint(
    [
      join(crateRoot, 'src', 'main.rs'),
      join(crateRoot, 'build.rs'),
      manifestPath,
      join(crateRoot, 'Cargo.lock'),
      join(crateRoot, 'app.manifest'),
      join(crateRoot, '.cargo', 'config.toml'),
      join(repoRoot, 'config/scripts/windows-rust-executable-build.mjs'),
      ...fingerprintInputs
    ],
    rustTarget ? `${version}\0${rustTarget}` : version
  )

  mkdirSync(dirname(outputPath), { recursive: true })
  if (shouldReuseCompiledWindowsRustExecutable(outputPath, fingerprint)) {
    console.log(`[native-build] reusing ${label} at ${outputPath}`)
    return
  }

  rmSync(`${outputPath}.sha256`, { force: true })
  const targetDirectory = join(crateRoot, 'target')
  const result = spawnSync(
    'cargo',
    [
      'build',
      '--release',
      '--locked',
      '--manifest-path',
      manifestPath,
      '--target-dir',
      targetDirectory,
      ...(rustTarget ? ['--target', rustTarget] : [])
    ],
    {
      cwd: crateRoot,
      stdio: 'inherit',
      env: { ...process.env, ...buildEnv(version) }
    }
  )

  if (result.signal) {
    process.kill(process.pid, result.signal)
  }
  if (result.error) {
    // Name missing toolchain explicitly; bare ENOENT misleadingly looks like missing source.
    throw new Error(
      `Unable to run cargo for the ${label}: ${result.error.message}. Install Rust (https://rustup.rs) and retry.`
    )
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }

  const builtPath = join(
    targetDirectory,
    ...(rustTarget ? [rustTarget] : []),
    'release',
    `${binName}.exe`
  )
  const vcRuntimeImports = findDynamicVcRuntimeImports(
    readPeImportedDllNames(readFileSync(builtPath))
  )
  if (vcRuntimeImports.length > 0) {
    // Why fatal: those DLLs ship with the Visual C++ Redistributable, so the binary would fail to start on a clean Windows install.
    throw new Error(
      `${binName}.exe imports ${vcRuntimeImports.join(', ')}; the C runtime must be linked statically (${join(crateRoot, '.cargo', 'config.toml')}).`
    )
  }
  copyFileSync(builtPath, outputPath)
  writeFileSync(`${outputPath}.sha256`, fingerprint)
}
