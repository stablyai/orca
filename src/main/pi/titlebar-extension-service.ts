import { materializeOmpFreshConfig } from '../../shared/omp-fresh-config'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { createHash } from 'node:crypto'
import {
  ORCA_PI_AGENT_STATUS_EXTENSION_FILE,
  getPiAgentStatusExtensionSource
} from './agent-status-extension-source'
import {
  ORCA_PI_PREFILL_EXTENSION_FILE,
  getPiPrefillExtensionSource
} from './prefill-extension-source'
import { ORCA_PI_EXTENSION_FILE, getPiTitlebarExtensionSource } from './titlebar-extension-source'
import {
  isSafeDescendCandidate as sharedIsSafeDescendCandidate,
  safeRemoveOverlay
} from '../pty/overlay-mirror'
import { migrateLegacyOmpOverlayState } from './legacy-omp-overlay-migration'
import type { PiAgentKind } from '../../shared/pi-agent-kind'

export const isSafeDescendCandidate = sharedIsSafeDescendCandidate

const PI_AGENT_SUBDIR = 'agent'
const ORCA_MANAGED_EXTENSION_MARKER = '@orca-managed-pi-extension'
const OMP_MANAGED_STATUS_EXTENSION_DIR = 'omp-managed-status-extension'

type ManagedExtensionWriteResult = 'written' | 'skipped-user-owned' | 'failed'

type PiManagedExtensionEnv = {
  extensionDir?: string
  sourceAgentDir: string
  statusExtensionPath?: string
}

type LegacyOverlayAgentKind = Exclude<PiAgentKind, 'prime-agent'>

// Retain old per-kind roots for upgrade cleanup.
const OVERLAY_ROOT_DIR_NAME: Record<LegacyOverlayAgentKind, string> = {
  pi: 'pi-agent-overlays',
  omp: 'omp-agent-overlays'
}

// Resolve by launched kind; disk-presence fallback would shadow the other agent's extensions.
const AGENT_HOME_DIR_NAME: Record<PiAgentKind, string> = {
  pi: '.pi',
  omp: '.omp',
  'prime-agent': '.prime'
}

function getDefaultPiAgentDir(kind: PiAgentKind, configDirName: string | undefined): string {
  const root = kind === 'omp' ? configDirName || AGENT_HOME_DIR_NAME.omp : AGENT_HOME_DIR_NAME[kind]
  return join(homedir(), root, PI_AGENT_SUBDIR)
}

function toSafeOverlayDirName(ptyId: string): string {
  return createHash('sha256').update(ptyId).digest('hex').slice(0, 32)
}

function withOrcaManagedExtensionMarker(source: string): string {
  return source.includes(ORCA_MANAGED_EXTENSION_MARKER)
    ? source
    : `// ${ORCA_MANAGED_EXTENSION_MARKER}\n${source}`
}

export class PiTitlebarExtensionService {
  private getOverlayRoot(kind: LegacyOverlayAgentKind): string {
    return join(getAppEnvironment().getPath('userData'), OVERLAY_ROOT_DIR_NAME[kind])
  }

  private getSourceOverlayDir(sourceAgentDir: string, kind: LegacyOverlayAgentKind): string {
    // Rescue state from overlays used before managed extensions.
    return join(this.getOverlayRoot(kind), toSafeOverlayDirName(`source:${sourceAgentDir}`))
  }

  private getPtyOverlayDir(ptyId: string, kind: LegacyOverlayAgentKind): string {
    // Resolve old PTY-scoped paths for migration cleanup.
    return join(this.getOverlayRoot(kind), toSafeOverlayDirName(ptyId))
  }

  private getLegacyOverlayDir(ptyId: string, kind: LegacyOverlayAgentKind): string {
    return join(this.getOverlayRoot(kind), ptyId)
  }

  private safeRemoveOverlay(overlayDir: string, kind: LegacyOverlayAgentKind): void {
    safeRemoveOverlay(overlayDir, this.getOverlayRoot(kind))
  }

  private canOverwriteManagedExtension(path: string): boolean {
    try {
      return readFileSync(path, 'utf8').includes(ORCA_MANAGED_EXTENSION_MARKER)
    } catch {
      return true
    }
  }

  private writeManagedExtension(path: string, source: string): ManagedExtensionWriteResult {
    if (existsSync(path) && !this.canOverwriteManagedExtension(path)) {
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
    const fallbackDir = join(
      getAppEnvironment().getPath('userData'),
      OMP_MANAGED_STATUS_EXTENSION_DIR
    )
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

    if (kind !== 'prime-agent') {
      this.writeManagedExtension(
        join(extensionsDir, ORCA_PI_EXTENSION_FILE),
        withOrcaManagedExtensionMarker(getPiTitlebarExtensionSource(kind))
      )
      this.writeManagedExtension(
        join(extensionsDir, ORCA_PI_PREFILL_EXTENSION_FILE),
        withOrcaManagedExtensionMarker(getPiPrefillExtensionSource(kind))
      )
    }
    const statusExtensionPath = join(extensionsDir, ORCA_PI_AGENT_STATUS_EXTENSION_FILE)
    const statusSource = withOrcaManagedExtensionMarker(getPiAgentStatusExtensionSource(kind))
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

  buildFreshOmpEnv(): Record<string, string> {
    return {
      ORCA_OMP_FRESH_CONFIG: materializeOmpFreshConfig(
        join(getAppEnvironment().getPath('userData'), OMP_MANAGED_STATUS_EXTENSION_DIR)
      )
    }
  }

  buildPtyEnv(
    ptyId: string,
    existingAgentDir: string | undefined,
    kind: PiAgentKind,
    options?: { materializeDefaultHome?: boolean; configDirName?: string }
  ): Record<string, string> {
    const freshConfigEnv = kind === 'omp' ? this.buildFreshOmpEnv() : {}
    const sourceAgentDir = existingAgentDir || getDefaultPiAgentDir(kind, options?.configDirName)
    if (kind !== 'prime-agent') {
      try {
        this.safeRemoveOverlay(this.getPtyOverlayDir(ptyId, kind), kind)
        this.safeRemoveOverlay(this.getLegacyOverlayDir(ptyId, kind), kind)
      } catch {
        // Locked legacy overlays must not prevent terminal startup.
      }
    }

    // Bare shells must not recreate deleted agent homes; materialize only on explicit opt-in (#10196).
    const materializeDefaultHome = options?.materializeDefaultHome !== false
    if (!existsSync(sourceAgentDir) && !materializeDefaultHome) {
      if (kind === 'omp') {
        const statusSource = withOrcaManagedExtensionMarker(getPiAgentStatusExtensionSource(kind))
        const statusExtensionPath = this.writeOmpFallbackStatusExtension(statusSource)
        return statusExtensionPath
          ? { ...freshConfigEnv, ORCA_OMP_STATUS_EXTENSION: statusExtensionPath }
          : freshConfigEnv
      }
      return {}
    }

    if (kind === 'omp') {
      migrateLegacyOmpOverlayState(sourceAgentDir, this.getSourceOverlayDir(sourceAgentDir, 'omp'))
    }

    const installed = this.installManagedExtensions(sourceAgentDir, kind)
    const env: Record<string, string> = { ...freshConfigEnv }
    if (kind === 'omp') {
      env.ORCA_OMP_SOURCE_AGENT_DIR = installed.sourceAgentDir
      if (installed.statusExtensionPath) {
        env.ORCA_OMP_STATUS_EXTENSION = installed.statusExtensionPath
      }
    } else if (kind === 'prime-agent') {
      env.ORCA_PRIME_AGENT_SOURCE_AGENT_DIR = installed.sourceAgentDir
    } else {
      env.ORCA_PI_SOURCE_AGENT_DIR = installed.sourceAgentDir
    }
    return env
  }

  clearPty(ptyId: string): void {
    // Teardown lacks agent kind; sweep both PTY roots but preserve source overlays containing user state.
    for (const kind of Object.keys(OVERLAY_ROOT_DIR_NAME) as LegacyOverlayAgentKind[]) {
      try {
        this.safeRemoveOverlay(this.getPtyOverlayDir(ptyId, kind), kind)
        this.safeRemoveOverlay(this.getLegacyOverlayDir(ptyId, kind), kind)
      } catch {
        // Windows AV/indexer locks leave harmless stale overlays; retry on the next spawn/teardown.
      }
    }
  }
}

export const piTitlebarExtensionService = new PiTitlebarExtensionService()
