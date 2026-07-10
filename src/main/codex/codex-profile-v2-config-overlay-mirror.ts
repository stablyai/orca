import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import { rewriteRelativePathConfigValues } from './codex-config-path-reference-rewrite'

function isProfileV2ConfigOverlayName(fileName: string): boolean {
  return fileName.endsWith('.config.toml') && fileName !== 'config.toml'
}

// Why: Codex profile-v2 loads `${CODEX_HOME}/<name>.config.toml` when selected.
// Resource linking covers the profile-v2/ directory, not free-standing overlays.
// Relative AbsolutePathBuf values must be rewritten against system CODEX_HOME
// the same way the main config.toml mirror does — symlink/copy alone leaves
// paths resolving from the managed home.
export function syncSystemProfileV2ConfigOverlaysIntoManagedHome(): void {
  const systemHomePath = getSystemCodexHomePath()
  const managedHomePath = getOrcaManagedCodexHomePath()
  let entries: string[]
  try {
    entries = readdirSync(systemHomePath)
  } catch {
    return
  }
  for (const fileName of entries) {
    if (!isProfileV2ConfigOverlayName(fileName)) {
      continue
    }
    mirrorSystemProfileV2ConfigOverlay(systemHomePath, managedHomePath, fileName)
  }
}

function mirrorSystemProfileV2ConfigOverlay(
  systemHomePath: string,
  managedHomePath: string,
  fileName: string
): void {
  const sourcePath = join(systemHomePath, fileName)
  const targetPath = join(managedHomePath, fileName)
  if (!existsSync(sourcePath)) {
    return
  }

  let raw: string
  try {
    raw = readFileSync(sourcePath, 'utf-8')
  } catch (error) {
    console.warn('[codex-config] Failed to read profile-v2 config overlay:', fileName, error)
    return
  }

  // Why: rewrite relative path keys against the *system* home so assets stay
  // reachable after the overlay lives under managed CODEX_HOME.
  const rewritten = rewriteRelativePathConfigValues(raw, systemHomePath)

  try {
    if (existsSync(targetPath)) {
      const targetStat = lstatSync(targetPath)
      if (targetStat.isSymbolicLink()) {
        // Why: a bare symlink keeps relative paths resolving against managed
        // home (or whatever Codex canonicalizes to). Replace with a rewritten
        // regular file.
        unlinkSync(targetPath)
      } else {
        try {
          if (readFileSync(targetPath, 'utf-8') === rewritten) {
            return
          }
        } catch {
          // Rewrite below.
        }
      }
    }
    writeFileAtomically(targetPath, rewritten)
  } catch (error) {
    console.warn('[codex-config] Failed to mirror profile-v2 config overlay:', fileName, error)
    try {
      rmSync(targetPath, { force: true })
    } catch {
      // best-effort cleanup
    }
  }
}
