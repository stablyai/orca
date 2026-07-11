import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getOrcaManagedCodexHomePath } from './codex-home-paths'
import { fingerprintCodexSessionFile } from './codex-session-copy-markers'

export type PreservedCodexSessionPaths = {
  dataPath: string
  recordPath: string
}

export function preservedCodexSessionPaths(relativePath: string): PreservedCodexSessionPaths {
  const rootPath = join(getOrcaManagedCodexHomePath(), '.orca-session-preserved')
  return {
    // The suffix intentionally keeps this out of Codex rollout discovery.
    dataPath: join(rootPath, `${relativePath}.orca-preserved`),
    recordPath: join(rootPath, `${relativePath}.json`)
  }
}

export function hasPreservedCodexSession(relativePath: string): boolean {
  const paths = preservedCodexSessionPaths(relativePath)
  return existsSync(paths.dataPath) || existsSync(paths.recordPath)
}

export function writePreservedCodexSessionRecord(args: {
  relativePath: string
  sourcePath: string
  originalTargetPath: string
  displacedTargetPath: string
}): void {
  const paths = preservedCodexSessionPaths(args.relativePath)
  mkdirSync(dirname(paths.recordPath), { recursive: true })
  writeFileSync(
    paths.recordPath,
    `${JSON.stringify(
      {
        version: 1,
        sourcePath: args.sourcePath,
        originalTargetPath: args.originalTargetPath,
        preservedPath: paths.dataPath,
        displacedTargetPath: args.displacedTargetPath,
        preservedFingerprintSha256: fingerprintCodexSessionFile(paths.dataPath),
        createdAt: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    { encoding: 'utf-8', flag: 'wx' }
  )
}
