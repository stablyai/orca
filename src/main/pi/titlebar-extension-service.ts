import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
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
  const sourceStats = statSync(sourcePath)

  if (process.platform === 'win32') {
    if (sourceStats.isDirectory()) {
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

  symlinkSync(sourcePath, targetPath, sourceStats.isDirectory() ? 'dir' : 'file')
}

export class PiTitlebarExtensionService {
  private getOverlayDir(ptyId: string): string {
    return join(app.getPath('userData'), PI_OVERLAY_DIR_NAME, ptyId)
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

    rmSync(overlayDir, { recursive: true, force: true })
    mkdirSync(overlayDir, { recursive: true })
    this.mirrorAgentDir(sourceAgentDir, overlayDir)

    const extensionsDir = join(overlayDir, 'extensions')
    mkdirSync(extensionsDir, { recursive: true })
    // Why: Pi auto-loads global extensions from PI_CODING_AGENT_DIR/extensions.
    // Add Orca's titlebar extension alongside the user's existing extensions
    // instead of replacing that directory, otherwise Orca terminals would
    // silently disable the user's Pi customization inside Orca only.
    writeFileSync(join(extensionsDir, ORCA_PI_EXTENSION_FILE), getPiTitlebarExtensionSource())

    return {
      PI_CODING_AGENT_DIR: overlayDir
    }
  }

  clearPty(ptyId: string): void {
    rmSync(this.getOverlayDir(ptyId), { recursive: true, force: true })
  }
}

export const piTitlebarExtensionService = new PiTitlebarExtensionService()
