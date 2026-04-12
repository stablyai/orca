import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync, chmodSync } from 'fs'
import { delimiter, join } from 'path'
import { app } from 'electron'

const ORCA_PI_EXTENSION_FILE = 'orca-titlebar-spinner.ts'
const ORCA_PI_WRAPPER_FILE = process.platform === 'win32' ? 'pi.cmd' : 'pi'

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

function getUnixWrapperSource(): string {
  return [
    '#!/bin/sh',
    '# Why: Pi only loads extra titlebar behavior via extension files. Orca',
    '# prepends this PTY-local wrapper to PATH so every `pi` launch gets the',
    "# spinner extension without overwriting the user's PI_CODING_AGENT_DIR.",
    'exec "$ORCA_PI_REAL_BIN" --extension "$ORCA_PI_EXTENSION_PATH" "$@"',
    ''
  ].join('\n')
}

function getWindowsWrapperSource(): string {
  return [
    '@echo off',
    'REM Why: Pi only exposes spinner title updates through an extension. Orca',
    'REM prepends this PTY-local wrapper to PATH so every `pi` launch gets the',
    "REM spinner extension without replacing the user's Pi config directory.",
    '"%ORCA_PI_REAL_BIN%" --extension "%ORCA_PI_EXTENSION_PATH%" %*',
    ''
  ].join('\r\n')
}

function resolvePiBinary(): string | null {
  try {
    if (process.platform === 'win32') {
      const stdout = execFileSync('where.exe', ['pi'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      return (
        stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean) || null
      )
    }

    const stdout = execFileSync('which', ['pi'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

export class PiTitlebarExtensionService {
  buildPtyEnv(existingPath: string | undefined): Record<string, string> {
    const realPiPath = resolvePiBinary()
    if (!realPiPath) {
      return {}
    }

    const runtimeDir = join(app.getPath('userData'), 'pi-runtime')
    const binDir = join(runtimeDir, 'bin')
    mkdirSync(binDir, { recursive: true })

    const extensionPath = join(runtimeDir, ORCA_PI_EXTENSION_FILE)
    writeFileSync(extensionPath, getPiTitlebarExtensionSource())

    const wrapperPath = join(binDir, ORCA_PI_WRAPPER_FILE)
    writeFileSync(
      wrapperPath,
      process.platform === 'win32' ? getWindowsWrapperSource() : getUnixWrapperSource()
    )
    if (process.platform !== 'win32') {
      chmodSync(wrapperPath, 0o755)
    }

    return {
      // Why: `pi` is launched manually inside an interactive shell, not through
      // Orca's direct provider spawner. Prepending a wrapper directory is the
      // only way to add the titlebar extension for arbitrary future `pi`
      // commands without mutating the user's global Pi config directory.
      PATH: existingPath ? `${binDir}${delimiter}${existingPath}` : binDir,
      ORCA_PI_REAL_BIN: realPiPath,
      ORCA_PI_EXTENSION_PATH: extensionPath
    }
  }
}

export const piTitlebarExtensionService = new PiTitlebarExtensionService()
