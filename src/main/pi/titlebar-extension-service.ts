import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { app } from 'electron'
import { createHash } from 'crypto'
import {
  ORCA_PI_AGENT_STATUS_EXTENSION_FILE,
  getPiAgentStatusExtensionSource
} from './agent-status-extension-source'
import {
  isSafeDescendCandidate as sharedIsSafeDescendCandidate,
  mirrorEntry,
  safeRemoveOverlay
} from '../pty/overlay-mirror'
import { mergePiOverlayUiSettings } from '../../shared/pi-overlay-ui-settings'
import type { PiAgentKind } from '../../shared/pi-agent-kind'

// Why: the Pi test suite imports `isSafeDescendCandidate` from this module's
// public surface to lock in the Windows-junction ordering invariant against
// future refactors. Re-export the shared implementation so the test contract
// keeps holding after the helper moved to src/main/pty/overlay-mirror.ts.
export const isSafeDescendCandidate = sharedIsSafeDescendCandidate

const ORCA_PI_EXTENSION_FILE = 'orca-titlebar-spinner.ts'
const ORCA_PI_PREFILL_EXTENSION_FILE = 'orca-prefill.ts'
const PI_AGENT_SUBDIR = 'agent'
const PI_AGENT_SETTINGS_FILE = 'settings.json'

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

// Why: prefill-without-submit needs an env-var the bundled `orca-prefill.ts`
// extension can read on session_start. Each kind owns its own variable so an
// OMP PTY never honors a Pi draft (or vice versa) - the only state the two
// share is the binary-mandated `PI_CODING_AGENT_DIR` itself. Pi keeps its
// original name for back-compat with PTYs already in flight at upgrade time;
// OMP gets a parallel `ORCA_OMP_PREFILL`.
const PREFILL_ENV_VAR_BY_KIND: Record<PiAgentKind, string> = {
  pi: 'ORCA_PI_PREFILL',
  omp: 'ORCA_OMP_PREFILL'
}

/** Pi's prefill env var. Exported for callers that need the literal name
 *  (renderer draft-launch plan builder, tests). OMP callers should read
 *  `ORCA_OMP_PREFILL_ENV_VAR` instead. */
export const ORCA_PI_PREFILL_ENV_VAR = PREFILL_ENV_VAR_BY_KIND.pi

/** OMP's prefill env var. Mirrors `ORCA_PI_PREFILL_ENV_VAR` for OMP launches
 *  so renderer plans and shell-ready restore lines can stay agent-scoped. */
export const ORCA_OMP_PREFILL_ENV_VAR = PREFILL_ENV_VAR_BY_KIND.omp

// Why: pi/OMP both expose an `ExtensionAPI` to the default-exported factory.
// The extension reads its kind-specific env var on session_start and types
// the payload into the editor without submitting. The env var is consumed
// (deleted from process.env) so `/new` in the same session doesn't re-prefill.
// The extension API name is identical between pi and OMP because OMP keeps
// Pi's `@oh-my-pi/*` runtime packages.
function getPiPrefillExtensionSource(kind: PiAgentKind): string {
  const envVar = PREFILL_ENV_VAR_BY_KIND[kind]
  return [
    'export default function (pi) {',
    "  pi.on('session_start', async (event, ctx) => {",
    "    if (event.reason !== 'startup') return",
    `    const prefill = process.env.${envVar}`,
    '    if (!prefill) return',
    `    delete process.env.${envVar}`,
    '    try {',
    '      ctx.ui.setEditorText(prefill)',
    '    } catch {}',
    '  })',
    '}',
    ''
  ].join('\n')
}

function getPiTitlebarExtensionSource(): string {
  return [
    'const BRAILLE_FRAMES = [',
    "  '\\u280b',",
    "  '\\u2819',",
    "  '\\u2839',",
    "  '\\u2838',",
    "  '\\u283c',",
    "  '\\u2834',",
    "  '\\u2826',",
    "  '\\u2827',",
    "  '\\u2807',",
    "  '\\u280f'",
    ']',
    '',
    'function getBaseTitle(pi) {',
    '  const cwd = process.cwd().split(/[\\\\/]/).filter(Boolean).at(-1) || process.cwd()',
    '  const session = pi.getSessionName()',
    '  return session ? `\\u03c0 - ${session} - ${cwd}` : `\\u03c0 - ${cwd}`',
    '}',
    '',
    'export default function (pi) {',
    '  let timer = null',
    '  let frameIndex = 0',
    '',
    '  function stopAnimation(ctx) {',
    '    if (timer) {',
    '      clearInterval(timer)',
    '      timer = null',
    '    }',
    '    frameIndex = 0',
    '    ctx.ui.setTitle(getBaseTitle(pi))',
    '  }',
    '',
    '  function startAnimation(ctx) {',
    '    stopAnimation(ctx)',
    '    timer = setInterval(() => {',
    '      const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length]',
    '      const cwd = process.cwd().split(/[\\\\/]/).filter(Boolean).at(-1) || process.cwd()',
    '      const session = pi.getSessionName()',
    '      const title = session ? `${frame} \\u03c0 - ${session} - ${cwd}` : `${frame} \\u03c0 - ${cwd}`',
    '      ctx.ui.setTitle(title)',
    '      frameIndex++',
    '    }, 80)',
    '  }',
    '',
    "  pi.on('agent_start', async (_event, ctx) => {",
    '    startAnimation(ctx)',
    '  })',
    '',
    "  pi.on('agent_end', async (_event, ctx) => {",
    '    stopAnimation(ctx)',
    '  })',
    '',
    "  pi.on('session_shutdown', async (_event, ctx) => {",
    '    stopAnimation(ctx)',
    '  })',
    '}',
    ''
  ].join('\n')
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

  private getOverlayDir(ptyId: string, kind: PiAgentKind): string {
    // Why: daemon PTY session ids include worktree paths. Hashing keeps the
    // overlay stable across daemon cold restore without path-shaped dirs.
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

  private mirrorAgentDir(sourceAgentDir: string, overlayDir: string): void {
    if (!existsSync(sourceAgentDir)) {
      return
    }

    for (const entry of readdirSync(sourceAgentDir, { withFileTypes: true })) {
      const sourcePath = join(sourceAgentDir, entry.name)

      if (entry.name === PI_AGENT_SETTINGS_FILE) {
        continue
      }

      if (entry.name === 'extensions' && entry.isDirectory()) {
        const overlayExtensionsDir = join(overlayDir, 'extensions')
        mkdirSync(overlayExtensionsDir, { recursive: true })
        for (const extensionEntry of readdirSync(sourcePath, { withFileTypes: true })) {
          mirrorEntry(
            join(sourcePath, extensionEntry.name),
            join(overlayExtensionsDir, extensionEntry.name)
          )
        }
        continue
      }

      // Why: PI_CODING_AGENT_DIR controls Pi's / OMP's entire state tree, not
      // just extension discovery. Mirror the user's top-level resources into
      // the overlay so enabling Orca's titlebar extension preserves auth,
      // sessions, skills, prompts, themes, and any future files stored there.
      mirrorEntry(sourcePath, join(overlayDir, basename(sourcePath)))
    }
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
    const overlayDir = this.getOverlayDir(ptyId, kind)

    try {
      this.safeRemoveOverlay(overlayDir, kind)
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
      this.mirrorAgentDir(sourceAgentDir, overlayDir)
      this.writeOverlaySettings(sourceAgentDir, overlayDir)

      const extensionsDir = join(overlayDir, 'extensions')
      mkdirSync(extensionsDir, { recursive: true })
      // Why: Pi / OMP both auto-load global extensions from
      // PI_CODING_AGENT_DIR/extensions. Add Orca's titlebar extension alongside
      // the user's existing extensions instead of replacing that directory,
      // otherwise Orca terminals would silently disable the user's
      // customization inside Orca only.
      writeFileSync(join(extensionsDir, ORCA_PI_EXTENSION_FILE), getPiTitlebarExtensionSource())
      writeFileSync(
        join(extensionsDir, ORCA_PI_PREFILL_EXTENSION_FILE),
        getPiPrefillExtensionSource(kind)
      )
      // Why: bundled status extension that bridges the in-process event API
      // (`pi.on('agent_start', ...)` etc., identical between Pi and OMP) to the
      // unified /hook/<kind> endpoint. Without this, panes would have no entry in
      // agentStatusByPaneKey and the dashboard would fall back to terminal-title
      // heuristics like any uninstrumented CLI.
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
    // exit path discards the launch command). Sweep both overlay roots so
    // either kind's overlay is cleaned up; the per-kind root scoping keeps
    // each safeRemoveOverlay call bounded to its own tree.
    for (const kind of Object.keys(OVERLAY_ROOT_DIR_NAME) as PiAgentKind[]) {
      try {
        this.safeRemoveOverlay(this.getOverlayDir(ptyId, kind), kind)
        this.safeRemoveOverlay(this.getLegacyOverlayDir(ptyId, kind), kind)
      } catch {
        // Why: on Windows the overlay dir can be locked (EPERM/EBUSY) by
        // antivirus or indexers. Overlay cleanup is best-effort - a stale
        // directory in userData is harmless and will be overwritten on the
        // next PTY spawn attempt.
      }
    }
  }
}

export const piTitlebarExtensionService = new PiTitlebarExtensionService()
