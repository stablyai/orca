import { createHash } from 'node:crypto'
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProcessSync } from './script-child-process.mjs'
import {
  WINDOWS_WATCHER_VERSION,
  WINDOWS_WATCHER_PATCH,
  readWindowsWatcherArtifact
} from './windows-watcher-artifact.mjs'

const root = resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
const { PE_MACHINE, readPeMachine } = require('./windows-pe-machine.cjs')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function runWindowsWatcherBuildCommand(program, args, cwd, timeoutMs = 300_000) {
  const result = runProcessSync({ program, args, cwd, stdio: 'inherit', timeoutMs })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(
      `Windows watcher build command failed: ${program} (${result.timedOut ? `timed out after ${timeoutMs}ms` : `exit ${result.code}`})`
    )
  }
}

// Never rebuild inside node_modules: concurrent desktop/relay builds share that tree.
export function stageWindowsWatcherSource(destination, { sanitize = false } = {}) {
  const packageDir = join(root, 'node_modules/@parcel/watcher')
  const { version } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  if (version !== WINDOWS_WATCHER_VERSION) {
    throw new Error(`Requalify the Windows readiness patch for watcher ${version}`)
  }
  mkdirSync(destination, { recursive: true })
  cpSync(join(packageDir, 'src'), join(destination, 'src'), { recursive: true })
  const binding = readFileSync(join(packageDir, 'binding.gyp'), 'utf8')
  let stagedBinding = binding.replace(
    /"include_dirs"[^\n]+/,
    '"include_dirs": ["deps/node-addon-api"],'
  )
  if (stagedBinding === binding) {
    throw new Error('Watcher header configuration changed')
  }
  if (sanitize) {
    for (const [before, after] of [
      ['"-std:c++17",', '"/fsanitize=address", "-std:c++17",'],
      ['"VCCLCompilerTool": {', '"VCCLCompilerTool": { "WholeProgramOptimization": "false",'],
      ['"/DYNAMICBASE",', '"/INCREMENTAL:NO", "/DYNAMICBASE",']
    ]) {
      if (!stagedBinding.includes(before)) {
        throw new Error(`Watcher sanitizer build configuration changed: ${before}`)
      }
      stagedBinding = stagedBinding.replace(before, after)
    }
  }
  writeFileSync(join(destination, 'binding.gyp'), stagedBinding)
  const headers = join(destination, 'deps/node-addon-api')
  mkdirSync(headers, { recursive: true })
  for (const file of readdirSync(join(root, 'node_modules/node-addon-api'))) {
    if (file.endsWith('.h')) {
      copyFileSync(join(root, 'node_modules/node-addon-api', file), join(headers, file))
    }
  }
  copyFileSync(join(packageDir, 'LICENSE'), join(destination, 'LICENSE'))
  runWindowsWatcherBuildCommand(
    'git',
    ['apply', '--no-index', '--check', WINDOWS_WATCHER_PATCH],
    destination
  )
  runWindowsWatcherBuildCommand('git', ['apply', '--no-index', WINDOWS_WATCHER_PATCH], destination)
}

export function buildWindowsWatcherAddon(arch = process.arch, { asanRuntime } = {}) {
  if (process.platform !== 'win32') {
    throw new Error('Build the Windows watcher on a Windows runner')
  }
  if (!Object.hasOwn(PE_MACHINE, arch)) {
    throw new Error(`Unsupported Windows watcher architecture: ${arch}`)
  }
  if (asanRuntime && (arch !== 'x64' || readPeMachine(asanRuntime) !== PE_MACHINE.x64)) {
    throw new Error('The watcher sanitizer gate requires the x64 MSVC AddressSanitizer runtime')
  }
  const output = join(
    root,
    asanRuntime ? '.build/windows-watcher-sanitizer' : '.build/windows-watcher',
    arch
  )
  mkdirSync(output, { recursive: true })
  const staging = mkdtempSync(join(output, 'source-'))
  return runWindowsWatcherBuild(
    () => {
      stageWindowsWatcherSource(staging, { sanitize: Boolean(asanRuntime) })
      runWindowsWatcherBuildCommand(
        process.execPath,
        [join(root, 'node_modules/node-gyp/bin/node-gyp.js'), 'rebuild', `--arch=${arch}`],
        staging,
        // ARM64 cold toolchain discovery can consume most of the previous five-minute budget.
        600_000
      )
      const binary = join(staging, 'build/Release/watcher.node')
      if (readPeMachine(binary) !== PE_MACHINE[arch]) {
        throw new Error(`Watcher compiler emitted the wrong architecture for ${arch}`)
      }
      const bytes = readFileSync(binary)
      copyFileSync(binary, join(output, 'watcher.node'))
      copyFileSync(join(staging, 'LICENSE'), join(output, 'LICENSE'))
      if (asanRuntime) {
        copyFileSync(asanRuntime, join(output, 'clang_rt.asan_dynamic-x86_64.dll'))
        copyFileSync(join(staging, 'build/Release/watcher.pdb'), join(output, 'watcher.pdb'))
      }
      writeFileSync(
        join(output, 'manifest.json'),
        `${JSON.stringify({
          version: WINDOWS_WATCHER_VERSION,
          arch,
          sanitized: Boolean(asanRuntime),
          patchSha256: hash(readFileSync(WINDOWS_WATCHER_PATCH)),
          sha256: hash(bytes)
        })}\n`
      )
      if (!asanRuntime) {
        readWindowsWatcherArtifact(arch)
      }
      return output
    },
    () => rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  )
}

export function runWindowsWatcherBuild(build, cleanup) {
  let result
  let buildFailure
  try {
    result = build()
  } catch (error) {
    buildFailure = error
  }
  try {
    cleanup()
  } catch (cleanupError) {
    if (buildFailure) {
      throw new AggregateError([buildFailure, cleanupError], 'Watcher build and cleanup failed')
    }
    throw cleanupError
  }
  if (buildFailure) {
    throw buildFailure
  }
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const arch =
    process.argv.find((arg) => arg.startsWith('--arch='))?.slice('--arch='.length) ?? process.arch
  const runtimeIndex = process.argv.indexOf('--asan-runtime')
  const asanRuntime = runtimeIndex === -1 ? undefined : process.argv[runtimeIndex + 1]
  if (runtimeIndex !== -1 && !asanRuntime) {
    throw new Error('--asan-runtime requires the MSVC AddressSanitizer DLL path')
  }
  console.log(buildWindowsWatcherAddon(arch, { asanRuntime }))
}
