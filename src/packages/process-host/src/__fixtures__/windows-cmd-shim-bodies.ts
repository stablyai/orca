/**
 * Shim bodies transcribed verbatim from a real Windows 11 install, plus
 * builders that emit the same shapes around a caller-chosen target.
 *
 * The verbatim copies are what pins the shapes to reality: the resolver is only
 * allowed to recognise files these generators actually write, and a copy here
 * is how a reviewer checks that without a Windows box.
 *
 * Sources:
 *   %APPDATA%\npm\codex.cmd            — npm cmd-shim, node script
 *   %APPDATA%\npm\agent-browser.cmd    — npm cmd-shim, bundled .exe
 *   %APPDATA%\npm\pnx.cmd              — npm cmd-shim, extensionless target
 *   <repo>\node_modules\.bin\vitest.cmd— pnpm @zkochan/cmd-shim, node script
 *   %LOCALAPPDATA%\pnpm\bin\pnpm.CMD   — pnpm, bundled .exe
 *   %LOCALAPPDATA%\pnpm\bin\pn.CMD     — pnpm alias, bare PATH command
 */

function crlf(lines: readonly string[]): string {
  return `${lines.join('\r\n')}\r\n`
}

/** npm's `cmd-shim` for a node script — the shape MDE flagged as `codex.cmd`. */
export const REAL_CODEX_CMD = crlf([
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*'
])

/** npm's `cmd-shim` for a package that ships its own executable. */
export const REAL_AGENT_BROWSER_CMD = crlf([
  '@ECHO off',
  '"%~dp0node_modules\\agent-browser\\bin\\agent-browser-win32-x64.exe" %*'
])

/** npm's `cmd-shim` for an extensionless target — cmd resolves it via PATHEXT,
 * so it must NOT resolve. */
export const REAL_PNX_CMD = crlf([
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\pnpm\\pnx"   %*'
])

const VITEST_NODE_PATH = [
  'C:\\Users\\neil\\orca\\orca\\node_modules\\.pnpm\\vitest@4.1.11\\node_modules\\vitest\\node_modules',
  'C:\\Users\\neil\\orca\\orca\\node_modules\\.pnpm\\vitest@4.1.11\\node_modules',
  'C:\\Users\\neil\\orca\\orca\\node_modules\\.pnpm\\node_modules'
].join(';')

/** pnpm's `.bin` shim: two interpreter branches plus the NODE_PATH prepend. */
export const REAL_VITEST_CMD = crlf([
  '@SETLOCAL',
  '@IF NOT DEFINED NODE_PATH (',
  `  @SET "NODE_PATH=${VITEST_NODE_PATH}"`,
  ') ELSE (',
  `  @SET "NODE_PATH=${VITEST_NODE_PATH};%NODE_PATH%"`,
  ')',
  '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe"  "%~dp0\\..\\vitest\\vitest.mjs" %*',
  ') ELSE (',
  '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
  '  node  "%~dp0\\..\\vitest\\vitest.mjs" %*',
  ')'
])

export const REAL_VITEST_NODE_PATH = VITEST_NODE_PATH

/** pnpm's global shim for a bundled executable. */
export const REAL_PNPM_CMD = crlf([
  '@SETLOCAL',
  '@"%~dp0\\..\\global\\v11\\27d0-19f7df4c136-1fab7163f1a52461\\node_modules\\@pnpm\\exe\\pnpm.exe"   %*'
])

/** pnpm's `pn` alias: a bare PATH command, with nothing to resolve. */
export const REAL_PN_CMD = crlf(['@echo off', 'pnpm %*'])

/** The npm `%_prog%` shape around an arbitrary script. */
export function npmProgNodeShim(scriptRelative: string): string {
  return REAL_CODEX_CMD.replace('node_modules\\@openai\\codex\\bin\\codex.js', scriptRelative)
}

/** The pnpm two-branch shape, with the NODE_PATH block only when asked for. */
export function pnpmBranchedNodeShim(scriptRelative: string, nodePathPrefix?: string): string {
  return crlf([
    '@SETLOCAL',
    ...(nodePathPrefix
      ? [
          '@IF NOT DEFINED NODE_PATH (',
          `  @SET "NODE_PATH=${nodePathPrefix}"`,
          ') ELSE (',
          `  @SET "NODE_PATH=${nodePathPrefix};%NODE_PATH%"`,
          ')'
        ]
      : []),
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${scriptRelative}" %*`,
    ') ELSE (',
    '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
    `  node  "%~dp0\\${scriptRelative}" %*`,
    ')'
  ])
}

/** The npm one-line shape around an arbitrary target. */
export function npmDirectShim(targetRelative: string): string {
  return crlf(['@ECHO off', `"%~dp0${targetRelative}" %*`])
}
