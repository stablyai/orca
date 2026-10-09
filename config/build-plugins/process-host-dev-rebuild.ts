import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import ts from 'typescript-api'
import type { Plugin } from 'rolldown'
import { createWorkspaceSourceResolver } from '../scripts/workspace-source-exports.mjs'

function configError(diagnostic: ts.Diagnostic): Error {
  return new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
}

function processHostInputs(root: string): {
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
  const parsed = ts.getParsedCommandLineOfConfigFile(config, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw configError(diagnostic)
    }
  })
  if (!parsed || parsed.errors.length > 0) {
    throw parsed?.errors[0] ? configError(parsed.errors[0]) : new Error(`Cannot read ${config}`)
  }
  const configSource = parsed.options.configFile
  const inheritedConfigs =
    configSource && typeof configSource === 'object' && 'extendedSourceFiles' in configSource
      ? configSource.extendedSourceFiles
      : []
  return {
    directory,
    files: [manifest, config, ...parsed.fileNames, ...(inheritedConfigs ?? [])],
    directories: parsed.wildcardDirectories ?? {}
  }
}

export function createProcessHostDevRebuildPlugin(root = process.cwd()): Plugin {
  const directoryWatchers = new Map<string, { recursive: boolean; watcher: ts.FileWatcher }>()
  let signalDirectory: string | undefined
  let signalFile: string | undefined
  let signalVersion = 0
  return {
    name: 'orca-process-host-dev-rebuild',
    buildStart() {
      if (!this.meta.watchMode) {
        return
      }
      const inputs = processHostInputs(root)
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
        const recursive = flags === ts.WatchDirectoryFlags.Recursive
        const previous = directoryWatchers.get(directory)
        if (previous?.recursive === recursive) {
          continue
        }
        previous?.watcher.close()
        if (!ts.sys.watchDirectory) {
          throw new Error('The process-host source directory watcher is unavailable')
        }
        const watcher = ts.sys.watchDirectory(
          directory,
          () => {
            if (signalFile) {
              writeFileSync(signalFile, String(++signalVersion))
            }
          },
          recursive,
          { watchDirectory: ts.WatchDirectoryKind.UseFsEvents }
        )
        directoryWatchers.set(directory, { recursive, watcher })
      }
      // The external package must finish emitting before electron-vite restarts the app. The
      // package's own build keeps its compiler and per-file atomic dist sync identical to build:packages.
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
