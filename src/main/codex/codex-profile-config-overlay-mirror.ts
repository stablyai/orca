import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { forceFileAuthCredentialsStore } from './codex-config-auth-store'
import { rewriteRelativePathConfigValues } from './codex-config-path-reference-rewrite'

type CodexProfileConfigOverlayHomes = {
  runtimeHomePath: string
  sourceConfigDir: string
  systemHomePath: string
}

function isProfileConfigOverlayName(fileName: string): boolean {
  return fileName !== 'config.toml' && fileName.endsWith('.config.toml')
}

// Why: profile-v2 resolves sibling `<name>.config.toml` files from CODEX_HOME;
// a regular rewritten copy keeps relative assets anchored to the system home.
export function syncCodexProfileConfigOverlaysIntoManagedHome({
  runtimeHomePath,
  sourceConfigDir,
  systemHomePath
}: CodexProfileConfigOverlayHomes): void {
  let fileNames: string[]
  try {
    fileNames = readdirSync(systemHomePath)
  } catch {
    return
  }

  for (const fileName of fileNames) {
    if (!isProfileConfigOverlayName(fileName)) {
      continue
    }
    mirrorCodexProfileConfigOverlay({
      fileName,
      runtimeHomePath,
      sourceConfigDir,
      systemHomePath
    })
  }
}

function mirrorCodexProfileConfigOverlay({
  fileName,
  runtimeHomePath,
  sourceConfigDir,
  systemHomePath
}: CodexProfileConfigOverlayHomes & { fileName: string }): void {
  const sourcePath = join(systemHomePath, fileName)
  const targetPath = join(runtimeHomePath, fileName)
  try {
    const rewritten = forceFileAuthCredentialsStore(
      rewriteRelativePathConfigValues(readFileSync(sourcePath, 'utf-8'), sourceConfigDir)
    )
    mkdirSync(runtimeHomePath, { recursive: true })
    if (existsSync(targetPath)) {
      if (lstatSync(targetPath).isSymbolicLink()) {
        unlinkSync(targetPath)
      } else {
        try {
          if (readFileSync(targetPath, 'utf-8') === rewritten) {
            return
          }
        } catch {
          // Why: a stale unreadable target should still reach the atomic
          // writer, which owns the Windows ACL repair and replacement path.
        }
      }
    }
    writeFileAtomically(targetPath, rewritten)
  } catch (error) {
    console.warn('[codex-config] Failed to mirror profile config overlay:', fileName, error)
  }
}
