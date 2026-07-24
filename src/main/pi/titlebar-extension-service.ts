import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { createHash } from 'node:crypto'
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
  safeRemoveOverlay
} from '../pty/overlay-mirror'
import { migrateLegacyOmpOverlayState } from './legacy-omp-overlay-migration'
import {
  isManagedPiExtensionFile,
  withOrcaManagedPiExtensionMarker
} from './managed-extension-ownership'
import type { PiAgentKind } from '../../shared/pi-agent-kind'

// Why: the Pi test suite imports `isSafeDescendCandidate` from this module's
// public surface to lock in the Windows-junction ordering invariant against
// future refactors. Re-export the shared implementation so the test contract
// keeps holding after the helper moved to src/main/pty/overlay-mirror.ts.
export const isSafeDescendCandidate = sharedIsSafeDescendCandidate

const PI_AGENT_SUBDIR = 'agent'
const OMP_MANAGED_STATUS_EXTENSION_DIR = 'omp-managed-status-extension'

type ManagedExtensionWriteResult = 'written' | 'skipped-user-owned' | 'failed'

type PiManagedExtensionEnv = {
  extensionDir?: string
  sourceAgentDir: string
  statusExtensionPath?: string
}

// Why: old Orca versions used per-kind overlay roots. Keep the names so
// upgrade-time cleanup can remove stale PTY-scoped Pi/OMP overlay dirs without
// guessing which agent a terminated pane launched.
const OVERLAY_ROOT_DIR_NAME: Record<PiAgentKind, string> = {
  pi: 'pi-agent-overlays',
  omp: 'omp-agent-overlays'
}

// Why: the managed extension target is chosen by which agent is being launched, NOT
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
    // Why: builds before managed extensions stored Pi/OMP state in source-scoped
    // overlays. Resolve the old path so OMP upgrades can rescue stranded state.
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

  private writeManagedExtension(path: string, source: string): ManagedExtensionWriteResult {
    if (existsSync(path) && !isManagedPiExtensionFile(path)) {
      return 'skipped-user-owned'
    }

    try {
      writeFileSync(path, source)
      return 'written'
    } catch {
      return 'failed'
    }
  }

  private writeOmpFallbackStatusExtension(source: string): string | undefined {
    const fallbackDir = join(app.getPath('userData'), OMP_MANAGED_STATUS_EXTENSION_DIR)
    try {
      mkdirSync(fallbackDir, { recursive: true })
    } catch {
      return undefined
    }

    const fallbackPath = join(fallbackDir, ORCA_PI_AGENT_STATUS_EXTENSION_FILE)
    return this.writeManagedExtension(fallbackPath, source) === 'written' ? fallbackPath : undefined
  }

  private installManagedExtensions(
    sourceAgentDir: string,
    kind: PiAgentKind
  ): PiManagedExtensionEnv {
    const extensionsDir = join(sourceAgentDir, 'extensions')
    try {
      mkdirSync(extensionsDir, { recursive: true })
    } catch {
      return { sourceAgentDir }
    }

    this.writeManagedExtension(
      join(extensionsDir, ORCA_PI_EXTENSION_FILE),
      withOrcaManagedPiExtensionMarker(getPiTitlebarExtensionSource())
    )
    this.writeManagedExtension(
      join(extensionsDir, ORCA_PI_PREFILL_EXTENSION_FILE),
      withOrcaManagedPiExtensionMarker(getPiPrefillExtensionSource(kind))
    )
    const statusExtensionPath = join(extensionsDir, ORCA_PI_AGENT_STATUS_EXTENSION_FILE)
    const statusSource = withOrcaManagedPiExtensionMarker(getPiAgentStatusExtensionSource(kind))
    const statusResult = this.writeManagedExtension(statusExtensionPath, statusSource)

    return {
      extensionDir: extensionsDir,
      sourceAgentDir,
      statusExtensionPath:
        statusResult === 'written'
          ? statusExtensionPath
          : kind === 'omp'
            ? this.writeOmpFallbackStatusExtension(statusSource)
            : undefined
    }
  }

  buildPtyEnv(
    ptyId: string,
    existingAgentDir: string | undefined,
    kind: PiAgentKind
  ): Record<string, string> {
    const sourceAgentDir = existingAgentDir || getDefaultPiAgentDir(kind)
    try {
      this.safeRemoveOverlay(this.getPtyOverlayDir(ptyId, kind), kind)
      this.safeRemoveOverlay(this.getLegacyOverlayDir(ptyId, kind), kind)
    } catch {
      // Why: old per-PTY overlay cleanup is best-effort; a locked stale
      // directory should not prevent the terminal from starting.
    }

    if (kind === 'omp') {
      migrateLegacyOmpOverlayState(sourceAgentDir, this.getSourceOverlayDir(sourceAgentDir, 'omp'))
    }

    const installed = this.installManagedExtensions(sourceAgentDir, kind)
    const env: Record<string, string> = {}
    if (kind === 'omp') {
      env.ORCA_OMP_SOURCE_AGENT_DIR = installed.sourceAgentDir
      if (installed.statusExtensionPath) {
        env.ORCA_OMP_STATUS_EXTENSION = installed.statusExtensionPath
      }
    } else {
      env.ORCA_PI_SOURCE_AGENT_DIR = installed.sourceAgentDir
    }
    return env
  }

  clearPty(ptyId: string): void {
    // Why: PTY teardown doesn't know which kind was launched (the daemon
    // exit path discards the launch command). Sweep both old PTY-scoped
    // overlay roots for migration cleanup. Source-scoped legacy overlays are
    // deliberately left in place so upgrades never delete user runtime state.
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
