import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { app } from 'electron'
import {
  ORCA_PI_AGENT_STATUS_EXTENSION_FILE,
  getPiAgentStatusExtensionSource
} from './agent-status-extension-source'
import {
  isSafeDescendCandidate as sharedIsSafeDescendCandidate,
  mirrorEntry,
  safeRemoveOverlay
} from '../pty/overlay-mirror'

// Why: the Pi test suite imports `isSafeDescendCandidate` from this module's
// public surface to lock in the Windows-junction ordering invariant against
// future refactors. Re-export the shared implementation so the test contract
// keeps holding after the helper moved to src/main/pty/overlay-mirror.ts.
export const isSafeDescendCandidate = sharedIsSafeDescendCandidate

const ORCA_PI_EXTENSION_FILE = 'orca-titlebar-spinner.ts'
const ORCA_PI_PREFILL_EXTENSION_FILE = 'orca-prefill.ts'
const PI_AGENT_DIR_NAME = '.pi'
const PI_AGENT_SUBDIR = 'agent'
const PI_OVERLAY_DIR_NAME = 'pi-agent-overlays'

// Why: env-var name read by the prefill extension. Mirrors Claude's
// `--prefill <text>` semantics for pi — the editor mounts with the text
// already in its input box but unsubmitted, so the user can review/edit
// before sending. Used by the new-workspace draft-launch flow to drop a
// linked GitHub/Linear issue URL into pi without racing pi's lengthy
// startup output (banner + skills + extensions) against the bracketed-
// paste readiness detector.
export const ORCA_PI_PREFILL_ENV_VAR = 'ORCA_PI_PREFILL'

// Why: pi exposes `pi.ui.setEditorText(text)` from inside an extension's
// session_start handler — that's the equivalent of Claude's `--prefill`.
// We can't use a CLI flag (pi has none) and bracketed-paste-after-ready
// races against pi's startup output, so we ship a tiny extension that
// reads ORCA_PI_PREFILL on session_start and types it into the editor.
// The env var is consumed (deleted from process.env) so /new in the same
// session doesn't re-prefill.
function getPiPrefillExtensionSource(): string {
  return [
    'export default function (pi) {',
    "  pi.on('session_start', async (event, ctx) => {",
    "    if (event.reason !== 'startup') return",
    `    const prefill = process.env.${ORCA_PI_PREFILL_ENV_VAR}`,
    '    if (!prefill) return',
    `    delete process.env.${ORCA_PI_PREFILL_ENV_VAR}`,
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

function getDefaultPiAgentDir(): string {
  return join(homedir(), PI_AGENT_DIR_NAME, PI_AGENT_SUBDIR)
}

export class PiTitlebarExtensionService {
  private getOverlayRoot(): string {
    return join(app.getPath('userData'), PI_OVERLAY_DIR_NAME)
  }

  private getOverlayDir(ptyId: string): string {
    return join(this.getOverlayRoot(), ptyId)
  }

  // Why: overlay teardown must use the shared safeRemoveOverlay so the
  // Windows-junction guard from issue #1083 stays in lock-step across all
  // overlay consumers (Pi here, OpenCode in src/main/opencode/hook-service.ts).
  private safeRemoveOverlay(overlayDir: string): void {
    safeRemoveOverlay(overlayDir, this.getOverlayRoot())
  }

  private mirrorAgentDir(sourceAgentDir: string, overlayDir: string): void {
    if (!existsSync(sourceAgentDir)) {
      return
    }

    for (const entry of readdirSync(sourceAgentDir, { withFileTypes: true })) {
      const sourcePath = join(sourceAgentDir, entry.name)

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

      // Why: PI_CODING_AGENT_DIR controls Pi's entire state tree, not just
      // extension discovery. Mirror the user's top-level Pi resources into the
      // overlay so enabling Orca's titlebar extension preserves auth, sessions,
      // skills, prompts, themes, and any future files Pi stores there.
      mirrorEntry(sourcePath, join(overlayDir, basename(sourcePath)))
    }
  }

  buildPtyEnv(ptyId: string, existingAgentDir: string | undefined): Record<string, string> {
    const sourceAgentDir = existingAgentDir || getDefaultPiAgentDir()
    const overlayDir = this.getOverlayDir(ptyId)

    try {
      this.safeRemoveOverlay(overlayDir)
    } catch {
      // Why: on Windows the overlay directory can be locked by another process
      // (e.g. antivirus, indexer, or a previous Orca session that didn't clean up).
      // If we can't remove the stale overlay, fall back to the user's own Pi agent
      // dir so the terminal still spawns — the titlebar spinner is not worth
      // blocking the PTY.
      return existingAgentDir ? { PI_CODING_AGENT_DIR: existingAgentDir } : {}
    }

    try {
      mkdirSync(overlayDir, { recursive: true })
      this.mirrorAgentDir(sourceAgentDir, overlayDir)

      const extensionsDir = join(overlayDir, 'extensions')
      mkdirSync(extensionsDir, { recursive: true })
      // Why: Pi auto-loads global extensions from PI_CODING_AGENT_DIR/extensions.
      // Add Orca's titlebar extension alongside the user's existing extensions
      // instead of replacing that directory, otherwise Orca terminals would
      // silently disable the user's Pi customization inside Orca only.
      writeFileSync(join(extensionsDir, ORCA_PI_EXTENSION_FILE), getPiTitlebarExtensionSource())
      writeFileSync(
        join(extensionsDir, ORCA_PI_PREFILL_EXTENSION_FILE),
        getPiPrefillExtensionSource()
      )
      // Why: bundled status extension that bridges pi's in-process event API
      // to the unified /hook/pi endpoint. Without this, pi panes would have
      // no entry in agentStatusByPaneKey and the dashboard would fall back
      // to terminal-title heuristics like any uninstrumented CLI.
      writeFileSync(
        join(extensionsDir, ORCA_PI_AGENT_STATUS_EXTENSION_FILE),
        getPiAgentStatusExtensionSource()
      )
    } catch {
      // Why: overlay creation is best-effort — permission errors (EPERM/EACCES)
      // on Windows can occur when the userData directory is restricted or when
      // symlink/junction creation fails without developer mode. Fall back to the
      // user's Pi agent dir so the terminal spawns without the Orca extension.
      this.clearPty(ptyId)
      return existingAgentDir ? { PI_CODING_AGENT_DIR: existingAgentDir } : {}
    }

    return {
      PI_CODING_AGENT_DIR: overlayDir
    }
  }

  clearPty(ptyId: string): void {
    try {
      this.safeRemoveOverlay(this.getOverlayDir(ptyId))
    } catch {
      // Why: on Windows the overlay dir can be locked (EPERM/EBUSY) by antivirus
      // or indexers. Overlay cleanup is best-effort — a stale directory in userData
      // is harmless and will be overwritten on the next PTY spawn attempt.
    }
  }
}

export const piTitlebarExtensionService = new PiTitlebarExtensionService()
