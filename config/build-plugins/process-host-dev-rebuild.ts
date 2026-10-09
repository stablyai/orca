import { dirname, join, resolve } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import ts from 'typescript-api'
import type { Plugin } from 'rolldown'
import { createWorkspaceSourceResolver } from '../scripts/workspace-source-exports.mjs'

function configError(diagnostic: ts.Diagnostic): Error {
  return new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
}

function processHostInputs(root: string): { directory: string; files: string[] } {
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
    files: [manifest, config, ...parsed.fileNames, ...(inheritedConfigs ?? [])]
  }
}

export function createProcessHostDevRebuildPlugin(root = process.cwd()): Plugin {
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
      // The external package must finish emitting before electron-vite restarts the app.
      const result = runProcessSync({
        program: process.execPath,
        args: [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'],
        cwd: inputs.directory,
        timeoutMs: 60_000
      })
      if (result.code !== 0) {
        throw new Error(
          `[process-host-dev-rebuild] Package compilation failed: ${result.stderr || result.stdout || result.signal || result.code}`
        )
      }
    }
  }
}
