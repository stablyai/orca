import {
  cpSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { homedir } from 'os'
import { basename, join, relative, resolve, sep } from 'path'
import { app } from 'electron'

const ORCA_PI_EXTENSION_FILE = 'orca-titlebar-spinner.ts'
const PI_AGENT_DIR_NAME = '.pi'
const PI_AGENT_SUBDIR = 'agent'
const PI_OVERLAY_DIR_NAME = 'pi-agent-overlays'

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

function mirrorEntry(sourcePath: string, targetPath: string): void {
  // Why: lstatSync (not statSync) so that if the user's Pi dir contains its
  // OWN symlinks (e.g. skills symlinked from ~/.agents/skills), we mirror the
  // link itself rather than resolving it to a type and then creating a junction
  // at an unrelated path. isSymbolicLink() MUST be checked before isDirectory()
  // on Windows because directory junctions/reparse points report both true.
  const sourceStats = lstatSync(sourcePath)
  const isSymlink = sourceStats.isSymbolicLink()
  const isDirectoryLike = !isSymlink && sourceStats.isDirectory()

  if (process.platform === 'win32') {
    if (isDirectoryLike) {
      symlinkSync(sourcePath, targetPath, 'junction')
      return
    }

    try {
      linkSync(sourcePath, targetPath)
      return
    } catch {
      cpSync(sourcePath, targetPath)
      return
    }
  }

  symlinkSync(sourcePath, targetPath, isDirectoryLike ? 'dir' : 'file')
}

// Exported for tests. A "descend candidate" is an entry whose children we
// should recurse into when tearing down the overlay. Anything that is a
// symlink (including a Windows directory junction) must NOT be a candidate
// even if it also reports isDirectory() — following it would walk into the
// link target and delete user data, which is the bug in #1083.
export function isSafeDescendCandidate(stats: {
  isSymbolicLink(): boolean
  isDirectory(): boolean
}): boolean {
  if (stats.isSymbolicLink()) {
    return false
  }
  return stats.isDirectory()
}

export class PiTitlebarExtensionService {
  private getOverlayRoot(): string {
    return join(app.getPath('userData'), PI_OVERLAY_DIR_NAME)
  }

  private getOverlayDir(ptyId: string): string {
    return join(this.getOverlayRoot(), ptyId)
  }

  // Why: the overlay tree contains symlinks/junctions that point back into the
  // user's real Pi state (~/.pi/agent or $PI_CODING_AGENT_DIR). fs.rmSync with
  // { recursive: true } has repeatedly regressed on Windows when walking
  // NTFS junctions — it can follow them and delete the *target*, destroying
  // the user's skills, extensions, sessions, and auth.json. See issue #1083.
  //
  // Never descend into a symlink/junction here: for any non-real-directory
  // entry we unlink the link itself; only entries that are truly directories
  // on disk (our own extensions/ dir and the overlay root) are recursed into.
  // We also refuse to operate on any path outside the overlay root as a
  // last-line guard against PI_OVERLAY_DIR_NAME ever being mis-resolved.
  private safeRemoveOverlay(overlayDir: string): void {
    const overlayRoot = this.getOverlayRoot()
    const resolvedRoot = resolve(overlayRoot)
    const resolvedTarget = resolve(overlayDir)
    const rel = relative(resolvedRoot, resolvedTarget)
    if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`)) {
      // Target is not strictly inside the overlay root — refuse to touch it.
      // Log so a misconfigured caller does not silently leak overlays forever
      // with no signal that this guard is firing.
      console.warn(
        `[pi-titlebar] refusing to remove overlay outside root: target=${resolvedTarget} root=${resolvedRoot}`
      )
      return
    }
    this.safeRemoveTree(resolvedTarget)
  }

  private safeRemoveTree(path: string): void {
    let stat
    try {
      stat = lstatSync(path)
    } catch {
      return
    }

    // Any symlink or Windows junction is unlinked in place, NEVER descended.
    // statSync would follow the link and report the target's stats, which is
    // exactly the bug we are guarding against, so the check uses lstat.
    //
    // On Windows, lstat on a directory junction can report BOTH
    // isSymbolicLink() === true AND isDirectory() === true, so we MUST check
    // isSymbolicLink first — otherwise a junction enters the recursive branch
    // and readdirSync enumerates the link's target, the exact bug in #1083.
    if (!isSafeDescendCandidate(stat)) {
      try {
        unlinkSync(path)
      } catch {
        // Best-effort: antivirus/indexers can hold handles briefly on Windows.
        // A leftover link is harmless; the next spawn rebuilds the overlay.
      }
      return
    }

    let entries
    try {
      entries = readdirSync(path, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const child = join(path, entry.name)
      if (isSafeDescendCandidate(entry)) {
        this.safeRemoveTree(child)
        continue
      }
      try {
        unlinkSync(child)
      } catch {
        // best-effort, see above
      }
    }

    try {
      rmdirSync(path)
    } catch {
      // Directory may be non-empty if an unlink above failed; harmless.
    }
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
