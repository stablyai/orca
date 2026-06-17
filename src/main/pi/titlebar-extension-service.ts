import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { app } from 'electron'
import { createHash } from 'crypto'
import {
  ORCA_PI_AGENT_STATUS_EXTENSION_FILE,
  getPiAgentStatusExtensionSource
} from './agent-status-extension-source'
import {
  ORCA_PI_PREFILL_EXTENSION_FILE,
  getPiPrefillExtensionSource
} from './prefill-extension-source'
export { ORCA_OMP_PREFILL_ENV_VAR, ORCA_PI_PREFILL_ENV_VAR } from './prefill-extension-source'
import { ORCA_PI_EXTENSION_FILE, getPiTitlebarExtensionSource } from './titlebar-extension-source'
import {
  isSafeDescendCandidate as sharedIsSafeDescendCandidate,
  mirrorEntry,
  safeRemoveOverlay,
  safeRemoveTree
} from '../pty/overlay-mirror'
import {
  isOmpPersistentSqliteEntry,
  mirrorOmpPersistentSqliteFiles
} from '../pty/omp-sqlite-overlay'
import { mergePiOverlayUiSettings } from '../../shared/pi-overlay-ui-settings'
import type { PiAgentKind } from '../../shared/pi-agent-kind'

// Why: the Pi test suite imports `isSafeDescendCandidate` from this module's
// public surface to lock in the Windows-junction ordering invariant against
// future refactors. Re-export the shared implementation so the test contract
// keeps holding after the helper moved to src/main/pty/overlay-mirror.ts.
export const isSafeDescendCandidate = sharedIsSafeDescendCandidate

const PI_AGENT_SUBDIR = 'agent'
const PI_AGENT_SETTINGS_FILE = 'settings.json'
const PI_OVERLAY_MANIFEST_FILE = '.orca-pi-overlay-manifest.json'

type PiOverlayManifest = {
  topLevelEntries: string[]
  extensionEntries: string[]
}

// Why: each agent owns its own overlay tree so OMP launches never touch
// Pi's overlay dir (and vice versa). Shadowing one inside the other would
// re-introduce the cross-agent state leak the per-kind PR exists to prevent.
const OVERLAY_ROOT_DIR_NAME: Record<PiAgentKind, string> = {
  pi: 'pi-agent-overlays',
  omp: 'omp-agent-overlays'
}

// Why: the overlay source dir is chosen by which agent is being launched, NOT
// by which `~/.<agent>/agent` dir happens to exist on disk first. A
// cross-agent fallback (Pi -> OMP or vice versa) silently shadows the other
// agent's user extensions when both are installed and the user picks the
// shadowed one in Orca's per-launch agent picker.
const AGENT_HOME_DIR_NAME: Record<PiAgentKind, string> = {
  pi: '.pi',
  omp: '.omp'
}

function getDefaultPiAgentDir(kind: PiAgentKind): string {
  return join(homedir(), AGENT_HOME_DIR_NAME[kind], PI_AGENT_SUBDIR)
}

function toSafeOverlayDirName(ptyId: string): string {
  return createHash('sha256').update(ptyId).digest('hex').slice(0, 32)
}

export class PiTitlebarExtensionService {
  private getOverlayRoot(kind: PiAgentKind): string {
    return join(app.getPath('userData'), OVERLAY_ROOT_DIR_NAME[kind])
  }

  private getSourceOverlayDir(sourceAgentDir: string, kind: PiAgentKind): string {
    // Why: PI_CODING_AGENT_DIR is Pi's whole mutable home. Scope overlays to
    // the source home, not a PTY, so Orca Pi terminals share config/session
    // state while still avoiding writes to the user's real agent dir.
    return join(this.getOverlayRoot(kind), toSafeOverlayDirName(`source:${sourceAgentDir}`))
  }

  private getPtyOverlayDir(ptyId: string, kind: PiAgentKind): string {
    // Why: old Orca versions used PTY-scoped hashed overlays. Keep resolving
    // that path so new spawns/teardowns can clean stale pre-migration dirs.
    return join(this.getOverlayRoot(kind), toSafeOverlayDirName(ptyId))
  }

  private getLegacyOverlayDir(ptyId: string, kind: PiAgentKind): string {
    return join(this.getOverlayRoot(kind), ptyId)
  }

  // Why: overlay teardown must use the shared safeRemoveOverlay so the
  // Windows-junction guard from issue #1083 stays in lock-step across all
  // overlay consumers (Pi here, OpenCode in src/main/opencode/hook-service.ts).
  private safeRemoveOverlay(overlayDir: string, kind: PiAgentKind): void {
    safeRemoveOverlay(overlayDir, this.getOverlayRoot(kind))
  }

  private readOverlayManifest(overlayDir: string): PiOverlayManifest {
    try {
      const parsed = JSON.parse(
        readFileSync(join(overlayDir, PI_OVERLAY_MANIFEST_FILE), 'utf8')
      ) as Partial<PiOverlayManifest>
      return {
        topLevelEntries: Array.isArray(parsed.topLevelEntries) ? parsed.topLevelEntries : [],
        extensionEntries: Array.isArray(parsed.extensionEntries) ? parsed.extensionEntries : []
      }
    } catch {
      return { topLevelEntries: [], extensionEntries: [] }
    }
  }

  private writeOverlayManifest(overlayDir: string, manifest: PiOverlayManifest): void {
    writeFileSync(
      join(overlayDir, PI_OVERLAY_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`
    )
  }

  private clearManifestEntries(overlayDir: string, manifest: PiOverlayManifest): void {
    for (const entryName of manifest.topLevelEntries) {
      safeRemoveTree(join(overlayDir, entryName))
    }

    const overlayExtensionsDir = join(overlayDir, 'extensions')
    for (const entryName of manifest.extensionEntries) {
      safeRemoveTree(join(overlayExtensionsDir, entryName))
    }
  }

  private mirrorAgentDir(sourceAgentDir: string, overlayDir: string, kind: PiAgentKind): void {
    const previousManifest = this.readOverlayManifest(overlayDir)
    this.clearManifestEntries(overlayDir, previousManifest)

    const nextManifest: PiOverlayManifest = { topLevelEntries: [], extensionEntries: [] }

    if (!existsSync(sourceAgentDir)) {
      if (kind === 'omp') {
        nextManifest.topLevelEntries.push(
          ...mirrorOmpPersistentSqliteFiles(sourceAgentDir, overlayDir)
        )
      }
      this.writeOverlayManifest(overlayDir, nextManifest)
      return
    }

    for (const entry of readdirSync(sourceAgentDir, { withFileTypes: true })) {
      const sourcePath = join(sourceAgentDir, entry.name)

      if (entry.name === PI_AGENT_SETTINGS_FILE) {
        continue
      }

      if (kind === 'omp' && isOmpPersistentSqliteEntry(entry.name)) {
        continue
      }

      if (entry.name === 'extensions') {
        const isSymlink = entry.isSymbolicLink()
        let isLinkPointingToDir = false
        if (isSymlink) {
          try {
            isLinkPointingToDir = statSync(sourcePath).isDirectory()
          } catch {
            isLinkPointingToDir = false
          }
        }

        if (!entry.isDirectory() && !isLinkPointingToDir) {
          mirrorEntry(sourcePath, join(overlayDir, basename(sourcePath)))
          nextManifest.topLevelEntries.push(entry.name)
          continue
        }

        // Why: `extensions/` must be a real overlay directory so Orca's
        // bundled files are written only into userData, never through a user
        // symlink/junction that points at their real extension store.
        const resolvedSource = isLinkPointingToDir ? realpathSync(sourcePath) : sourcePath
        const overlayExtensionsDir = join(overlayDir, 'extensions')
        mkdirSync(overlayExtensionsDir, { recursive: true })
        for (const extensionEntry of readdirSync(resolvedSource, { withFileTypes: true })) {
          if (
            extensionEntry.name === ORCA_PI_EXTENSION_FILE ||
            extensionEntry.name === ORCA_PI_PREFILL_EXTENSION_FILE ||
            extensionEntry.name === ORCA_PI_AGENT_STATUS_EXTENSION_FILE
          ) {
            continue
          }
          mirrorEntry(
            join(resolvedSource, extensionEntry.name),
            join(overlayExtensionsDir, extensionEntry.name)
          )
          nextManifest.extensionEntries.push(extensionEntry.name)
        }
        continue
      }

      // Why: PI_CODING_AGENT_DIR controls Pi's / OMP's entire state tree, not
      // just extension discovery. Mirror the user's top-level resources into
      // the overlay so enabling Orca's titlebar extension preserves auth,
      // sessions, skills, prompts, themes, and any future files stored there.
      mirrorEntry(sourcePath, join(overlayDir, basename(sourcePath)))
      nextManifest.topLevelEntries.push(entry.name)
    }

    if (kind === 'omp') {
      nextManifest.topLevelEntries.push(
        ...mirrorOmpPersistentSqliteFiles(sourceAgentDir, overlayDir)
      )
    }

    this.writeOverlayManifest(overlayDir, nextManifest)
  }

  private readPiSettings(sourceAgentDir: string): unknown {
    const settingsPath = join(sourceAgentDir, PI_AGENT_SETTINGS_FILE)
    if (!existsSync(settingsPath)) {
      return {}
    }

    try {
      return JSON.parse(readFileSync(settingsPath, 'utf8'))
    } catch {
      return {}
    }
  }

  private writeOverlaySettings(sourceAgentDir: string, overlayDir: string): void {
    // Why: settings.json is a real overlay file, not a mirror, so Orca can
    // apply UI-only safeguards without modifying the user's Pi / OMP config.
    const settings = mergePiOverlayUiSettings(this.readPiSettings(sourceAgentDir))
    writeFileSync(
      join(overlayDir, PI_AGENT_SETTINGS_FILE),
      `${JSON.stringify(settings, null, 2)}\n`
    )
  }

  buildPtyEnv(
    ptyId: string,
    existingAgentDir: string | undefined,
    kind: PiAgentKind
  ): Record<string, string> {
    const sourceAgentDir = existingAgentDir || getDefaultPiAgentDir(kind)
    const overlayDir = this.getSourceOverlayDir(sourceAgentDir, kind)

    try {
      this.safeRemoveOverlay(this.getPtyOverlayDir(ptyId, kind), kind)
      this.safeRemoveOverlay(this.getLegacyOverlayDir(ptyId, kind), kind)
    } catch {
      // Why: on Windows the overlay directory can be locked by another process
      // (e.g. antivirus, indexer, or a previous Orca session that didn't clean up).
      // If we can't remove the stale overlay, fall back to the user's own
      // agent dir (Pi or OMP - both consume PI_CODING_AGENT_DIR) so the
      // terminal still spawns - the titlebar spinner is not worth blocking
      // the PTY.
      return existingAgentDir ? { PI_CODING_AGENT_DIR: existingAgentDir } : {}
    }

    try {
      mkdirSync(overlayDir, { recursive: true })
      this.mirrorAgentDir(sourceAgentDir, overlayDir, kind)
      this.writeOverlaySettings(sourceAgentDir, overlayDir)

      const extensionsDir = join(overlayDir, 'extensions')
      mkdirSync(extensionsDir, { recursive: true })
      // Why: Pi / OMP both auto-load global extensions from
      // PI_CODING_AGENT_DIR/extensions. Add Orca's titlebar extension alongside
      // the user's existing extensions instead of replacing that directory,
      // otherwise Orca terminals would silently disable the user's
      // customization inside Orca only.
      safeRemoveTree(join(extensionsDir, ORCA_PI_EXTENSION_FILE))
      writeFileSync(join(extensionsDir, ORCA_PI_EXTENSION_FILE), getPiTitlebarExtensionSource())
      safeRemoveTree(join(extensionsDir, ORCA_PI_PREFILL_EXTENSION_FILE))
      writeFileSync(
        join(extensionsDir, ORCA_PI_PREFILL_EXTENSION_FILE),
        getPiPrefillExtensionSource(kind)
      )
      // Why: bundled status extension that bridges the in-process event API
      // (`pi.on('agent_start', ...)` etc., identical between Pi and OMP) to the
      // unified /hook/<kind> endpoint. Without this, panes would have no entry in
      // agentStatusByPaneKey and the dashboard would fall back to terminal-title
      // heuristics like any uninstrumented CLI.
      safeRemoveTree(join(extensionsDir, ORCA_PI_AGENT_STATUS_EXTENSION_FILE))
      writeFileSync(
        join(extensionsDir, ORCA_PI_AGENT_STATUS_EXTENSION_FILE),
        getPiAgentStatusExtensionSource(kind)
      )
    } catch {
      // Why: overlay creation is best-effort - permission errors (EPERM/EACCES)
      // on Windows can occur when the userData directory is restricted or when
      // symlink/junction creation fails without developer mode. Fall back to
      // the user's own agent dir (Pi or OMP) so the terminal spawns without
      // the Orca extension.
      this.clearPty(ptyId)
      return existingAgentDir ? { PI_CODING_AGENT_DIR: existingAgentDir } : {}
    }

    return {
      PI_CODING_AGENT_DIR: overlayDir
    }
  }

  clearPty(ptyId: string): void {
    // Why: PTY teardown doesn't know which kind was launched (the daemon
    // exit path discards the launch command). Sweep both old PTY-scoped
    // overlay roots for migration cleanup, but leave source-scoped overlays
    // alive because another Pi terminal may be using the same source home.
    for (const kind of Object.keys(OVERLAY_ROOT_DIR_NAME) as PiAgentKind[]) {
      try {
        this.safeRemoveOverlay(this.getPtyOverlayDir(ptyId, kind), kind)
        this.safeRemoveOverlay(this.getLegacyOverlayDir(ptyId, kind), kind)
      } catch {
        // Why: on Windows the overlay dir can be locked (EPERM/EBUSY) by
        // antivirus or indexers. Overlay cleanup is best-effort - a stale
        // old PTY-scoped directory in userData is harmless and will be
        // retried on the next PTY spawn/teardown.
      }
    }
  }
}

export const piTitlebarExtensionService = new PiTitlebarExtensionService()
