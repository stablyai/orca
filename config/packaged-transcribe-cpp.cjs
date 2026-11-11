const { cpSync, existsSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

const TRANSCRIBE_CPP_PACKAGES = require('../src/shared/transcribe-cpp-packages.json')
// transcribe.dll needs MSVC runtime >= 14.40 (older ones crash in std::mutex); the system copy may be older.
const WINDOWS_CRT_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']
const MIN_WINDOWS_CRT_VERSION = [14, 40]

/**
 * The packages the speech host loads transcribe-cpp from, in load order: the ESM binding, koffi
 * (its FFI), koffi's prebuilt addon, and the target's native libraries. Each resolves from the
 * previous one's directory, as Node does at runtime. Null where the target ships no transcribe-cpp.
 */
function transcribeCppRuntimePackages(readPackage, electronPlatformName, architecture) {
  const native = TRANSCRIBE_CPP_PACKAGES[`${electronPlatformName}-${architecture}`]
  if (!native) {
    return null
  }
  const binding = readPackage('transcribe-cpp')
  const koffi = readPackage('koffi', binding.packageDir)
  const koffiAddon = readPackage(
    `@koromix/koffi-${electronPlatformName}-${architecture}`,
    koffi.packageDir
  )
  const nativeLibraries = readPackage(native, binding.packageDir)
  return [binding, koffi, koffiAddon, nativeLibraries]
}

function readFileVersion(dll) {
  const version = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${dll}').VersionInfo.FileVersion`],
    { encoding: 'utf8' }
  ).trim()
  return version.split(/[.,\s]+/).map((part) => Number.parseInt(part, 10))
}

function copyWindowsCrt(nativeDir) {
  const systemDir = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  for (const name of WINDOWS_CRT_DLLS) {
    const source = join(systemDir, name)
    if (!existsSync(source)) {
      throw new Error(
        `Packaging transcribe-cpp needs ${source} (Visual C++ 2015-2022 x64 runtime).`
      )
    }
    const [major, minor] = readFileVersion(source)
    if (!Number.isFinite(major) || !Number.isFinite(minor)) {
      throw new Error(`Cannot read the file version of ${source}.`)
    }
    const [minMajor, minMinor] = MIN_WINDOWS_CRT_VERSION
    if (major < minMajor || (major === minMajor && minor < minMinor)) {
      throw new Error(
        `${source} is ${major}.${minor}; transcribe-cpp needs ${MIN_WINDOWS_CRT_VERSION.join('.')}+. ` +
          'Install the latest Visual C++ 2015-2022 x64 redistributable on the build host.'
      )
    }
    // App-local beside transcribe.dll, which loads its dependencies from its own directory.
    cpSync(source, join(nativeDir, name))
  }
}

/** Copy transcribe-cpp into the slice's resources/node_modules, outside asar where koffi can dlopen it. */
function copyPackagedTranscribeCpp(readPackage, resourcesDir, electronPlatformName, architecture) {
  // beforePack's assertPackagedNativeVariantsInstalled already failed any real build missing these;
  // only an afterPack driven without it (packaging tests) gets here without them.
  if (missingTranscribeCppPackages(readPackage, electronPlatformName, architecture).length > 0) {
    return
  }
  const packages = transcribeCppRuntimePackages(readPackage, electronPlatformName, architecture)
  if (!packages) {
    return
  }
  for (const { name, packageDir } of packages) {
    const target = join(resourcesDir, 'node_modules', ...name.split('/'))
    cpSync(packageDir, target, { recursive: true, dereference: true })
  }
  if (electronPlatformName === 'win32') {
    copyWindowsCrt(join(resourcesDir, 'node_modules', ...packages[3].name.split('/')))
  }
}

/** The transcribe-cpp packages a target needs that this install lacks (install:release adds other CPUs). */
function missingTranscribeCppPackages(readPackage, electronPlatformName, architecture) {
  try {
    transcribeCppRuntimePackages(readPackage, electronPlatformName, architecture)
    return []
  } catch (error) {
    return [String(error.message ?? error)]
  }
}

module.exports = {
  copyPackagedTranscribeCpp,
  missingTranscribeCppPackages
}
