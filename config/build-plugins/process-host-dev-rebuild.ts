import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import type ts from 'typescript-api'
import type { Plugin } from 'rolldown'
import { createWorkspaceSourceResolver } from '../scripts/workspace-source-exports.mjs'

function configError(diagnostic: ts.Diagnostic, compiler: typeof ts): Error {
  return new Error(compiler.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
}

function processHostInputs(
  root: string,
  compiler: typeof ts
): {
  directory: string
  files: string[]
  directories: ts.MapLike<ts.WatchDirectoryFlags>
} {
  const source = createWorkspaceSourceResolver(root).resolve('@orca/process-host')
  if (!source) {
    throw new Error('The process-host workspace source export is missing')
  }
  const manifest = resolve(root, source.manifest)
  const directory = dirname(manifest)
  const config = join(directory, 'tsconfig.json')
  const parsed = compiler.getParsedCommandLineOfConfigFile(config, undefined, {
    ...compiler.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw configError(diagnostic, compiler)
    }
  })
  if (!parsed || parsed.errors.length > 0) {
    throw parsed?.errors[0]
      ? configError(parsed.errors[0], compiler)
      : new Error(`Cannot read ${config}`)
  }
  const configSource = parsed.options.configFile
  const inheritedConfigs =
    configSource && typeof configSource === 'object' && 'extendedSourceFiles' in configSource
      ? configSource.extendedSourceFiles
      : []
  // Follow explicit imports through exclusions without loading automatic type libraries.
  const sources = compiler
    .createProgram(parsed.fileNames, { ...parsed.options, noLib: true, types: [] })
    .getSourceFiles()
    .map((source) => source.fileName)
  return {
    directory,
    files: [manifest, config, ...sources, ...(inheritedConfigs ?? [])],
    directories: parsed.wildcardDirectories ?? {}
  }
}

export function createProcessHostDevRebuildPlugin(root = process.cwd()): Plugin {
  const directoryWatchers = new Map<string, { recursive: boolean; watcher: ts.FileWatcher }>()
  let signalDirectory: string | undefined
  let signalFile: string | undefined
  let signalVersion = 0
  let packageDirty = true
  let packageFiles = new Set<string>()
  let cachedInputs: ReturnType<typeof processHostInputs> | undefined
  return {
    name: 'orca-process-host-dev-rebuild',
    watchChange(id) {
      const file = resolve(id)
      if (packageFiles.has(file) || file === signalFile) {
        packageDirty = true
      }
    },
    async buildStart() {
      if (!this.meta.watchMode) {
        return
      }
      const { default: compiler } = await import('typescript-api')
      const inputs =
        packageDirty || !cachedInputs ? processHostInputs(root, compiler) : cachedInputs
      cachedInputs = inputs
      packageFiles = new Set(inputs.files.map((file) => resolve(file)))
      for (const file of inputs.files) {
        this.addWatchFile(file)
      }
      // The installed bundler invalidates exact files; source creation needs a private watch signal.
      if (!signalDirectory) {
        signalDirectory = mkdtempSync(join(tmpdir(), 'orca-process-host-watch-'))
        signalFile = join(signalDirectory, 'source-directory-change')
        writeFileSync(signalFile, String(signalVersion))
      }
      if (signalFile) {
        this.addWatchFile(signalFile)
      }
      for (const [directory, watched] of directoryWatchers) {
        if (inputs.directories[directory] === undefined) {
          watched.watcher.close()
          directoryWatchers.delete(directory)
        }
      }
      for (const [directory, flags] of Object.entries(inputs.directories)) {
        const recursive = flags === compiler.WatchDirectoryFlags.Recursive
        const previous = directoryWatchers.get(directory)
        if (previous?.recursive === recursive) {
          continue
        }
        previous?.watcher.close()
        if (!compiler.sys.watchDirectory) {
          throw new Error('The process-host source directory watcher is unavailable')
        }
        const watcher = compiler.sys.watchDirectory(
          directory,
          (changedPath) => {
            if (
              !packageDirty &&
              resolve(changedPath) !== resolve(directory) &&
              basename(changedPath).toLowerCase() !== 'package.json' &&
              !packageFiles.has(resolve(changedPath))
            ) {
              try {
                const next = processHostInputs(root, compiler)
                const files = new Set(next.files.map((file) => resolve(file)))
                if (
                  files.size === packageFiles.size &&
                  [...files].every((file) => packageFiles.has(file))
                ) {
                  return
                }
              } catch {
                // Let the build report invalid configuration instead of hiding the change.
              }
            }
            packageDirty = true
            if (signalFile) {
              writeFileSync(signalFile, String(++signalVersion))
            }
          },
          recursive,
          { watchDirectory: compiler.WatchDirectoryKind.UseFsEvents }
        )
        directoryWatchers.set(directory, { recursive, watcher })
      }
      if (!packageDirty) {
        return
      }
      // Finish external-package atomic dist emission before electron-vite restarts the app.
      const result = runProcessSync({
        program: process.execPath,
        args: [
          createRequire(join(inputs.directory, 'package.json')).resolve('tsx/cli'),
          '--conditions=orca-source',
          join(inputs.directory, 'scripts', 'build-dist.mjs')
        ],
        cwd: inputs.directory,
        timeoutMs: 60_000
      })
      if (result.code !== 0) {
        throw new Error(
          `[process-host-dev-rebuild] Package compilation failed: ${result.stderr || result.stdout || result.signal || result.code}`
        )
      }
      packageDirty = false
    },
    closeWatcher() {
      signalFile = undefined
      for (const { watcher } of directoryWatchers.values()) {
        watcher.close()
      }
      directoryWatchers.clear()
      if (signalDirectory) {
        rmSync(signalDirectory, { recursive: true, force: true })
        signalDirectory = undefined
      }
    }
  }
}
