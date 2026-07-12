import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, type Stats } from 'node:fs'
import { basename, join } from 'node:path'
import { forceFileAuthCredentialsStore } from './codex-config-auth-store'
import { rewriteRelativePathConfigValues } from './codex-config-path-reference-rewrite'
import {
  lstatProfileOverlayIfExists,
  publishActiveManagedOverlay,
  quarantineProfileOverlayTarget,
  removeProfileOverlayQuarantine,
  restoreRegularProfileOverlayQuarantine
} from './codex-profile-config-overlay-active-publish'

type CodexProfileConfigOverlayHomes = {
  runtimeHomePath: string
  sourceConfigDir: string
  systemHomePath: string
}

const PROFILE_OVERLAY_MARKER_PREFIX = '# orca-managed-profile-overlay:v1 sha256='
const PROFILE_OVERLAY_MARKER_PATTERN = /^# orca-managed-profile-overlay:v1 sha256=([a-f0-9]{64})\n/
const UTF8_BOM = '\uFEFF'

function getOverlayNameKey(fileName: string): string {
  return process.platform === 'win32' ? fileName.toLowerCase() : fileName
}

function isProfileConfigOverlayName(fileName: string): boolean {
  const key = getOverlayNameKey(fileName)
  return basename(fileName) === fileName && key !== 'config.toml' && key.endsWith('.config.toml')
}

// Why: profile-v2 resolves sibling `<name>.config.toml` files from CODEX_HOME;
// a regular rewritten copy keeps relative assets anchored to the system home.
export function syncCodexProfileConfigOverlaysIntoManagedHome({
  runtimeHomePath,
  sourceConfigDir,
  systemHomePath
}: CodexProfileConfigOverlayHomes): void {
  let systemFileNames: string[]
  try {
    systemFileNames = readdirSync(systemHomePath)
  } catch {
    // The source inventory is authoritative; without it, no target is stale.
    return
  }

  const activeOverlayNames = systemFileNames.filter(isProfileConfigOverlayName)
  const activeOverlayKeys = new Set(activeOverlayNames.map(getOverlayNameKey))
  for (const fileName of activeOverlayNames) {
    mirrorCodexProfileConfigOverlay({
      fileName,
      runtimeHomePath,
      sourceConfigDir,
      systemHomePath
    })
  }
  removeStaleManagedOverlays(runtimeHomePath, activeOverlayKeys)
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
    const managedContents = addProfileOverlayOwnershipMarker(rewritten)
    mkdirSync(runtimeHomePath, { recursive: true })
    const targetMetadata = lstatProfileOverlayIfExists(targetPath)
    if (targetMetadata && !targetMetadata.isFile()) {
      console.warn('[codex-config] Skipped non-regular profile config overlay target:', fileName)
      return
    }
    if (targetMetadata) {
      try {
        if (readFileSync(targetPath, 'utf-8') === managedContents) {
          return
        }
      } catch {
        // The staged publisher owns safe replacement and Windows ACL repair.
      }
    }
    publishActiveManagedOverlay({
      fileName,
      managedContents,
      replaceExisting: targetMetadata !== null,
      targetPath
    })
  } catch (error) {
    console.warn('[codex-config] Failed to mirror profile config overlay:', fileName, error)
  }
}

function addProfileOverlayOwnershipMarker(rewritten: string): string {
  const hasBom = rewritten.startsWith(UTF8_BOM)
  const body = hasBom ? rewritten.slice(1) : rewritten
  const marker = `${PROFILE_OVERLAY_MARKER_PREFIX}${sha256(body)}\n`
  return `${hasBom ? UTF8_BOM : ''}${marker}${body}`
}

function removeStaleManagedOverlays(
  runtimeHomePath: string,
  activeOverlayKeys: ReadonlySet<string>
): void {
  let runtimeFileNames: string[]
  try {
    runtimeFileNames = readdirSync(runtimeHomePath)
  } catch {
    return
  }

  for (const fileName of runtimeFileNames) {
    if (
      !isProfileConfigOverlayName(fileName) ||
      activeOverlayKeys.has(getOverlayNameKey(fileName))
    ) {
      continue
    }
    removeStaleManagedOverlay(runtimeHomePath, fileName)
  }
}

function removeStaleManagedOverlay(runtimeHomePath: string, fileName: string): void {
  const targetPath = join(runtimeHomePath, fileName)
  let targetMetadata: Stats | null
  try {
    targetMetadata = lstatProfileOverlayIfExists(targetPath)
  } catch (error) {
    warnStaleOverlayFailure('inspect', fileName, error)
    return
  }
  if (!targetMetadata?.isFile()) {
    return
  }

  // Same-directory rename isolates one path before ownership is inspected.
  const quarantinePath = quarantineProfileOverlayTarget(targetPath, fileName)
  if (!quarantinePath) {
    return
  }

  let isManaged = false
  try {
    isManaged = hasValidProfileOverlayOwnershipMarker(readFileSync(quarantinePath, 'utf-8'))
  } catch {
    restoreRegularProfileOverlayQuarantine(quarantinePath, targetPath, fileName)
    return
  }

  if (!isManaged) {
    restoreRegularProfileOverlayQuarantine(quarantinePath, targetPath, fileName)
    return
  }
  removeProfileOverlayQuarantine(quarantinePath, fileName)
}

function hasValidProfileOverlayOwnershipMarker(contents: string): boolean {
  const withoutBom = contents.startsWith(UTF8_BOM) ? contents.slice(1) : contents
  const marker = withoutBom.match(PROFILE_OVERLAY_MARKER_PATTERN)
  if (!marker) {
    return false
  }
  const body = withoutBom.slice(marker[0].length)
  return sha256(body) === marker[1]
}

function warnStaleOverlayFailure(action: string, fileName: string, reason: unknown): void {
  console.warn(`[codex-config] Failed to ${action} stale profile config overlay:`, fileName, reason)
}

function sha256(contents: string): string {
  return createHash('sha256').update(contents, 'utf-8').digest('hex')
}
