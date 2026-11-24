/** Verbatim Windows 11 shims from:
 * npm: %APPDATA%\npm\{codex,agent-browser,pnx}.cmd
 * pnpm: <repo>\node_modules\.bin\vitest.cmd; %LOCALAPPDATA%\pnpm\bin\{pnpm,pn}.CMD
 */

function crlf(lines: readonly string[]): string {
  return `${lines.join('\r\n')}\r\n`
}

// npm node-script shim.
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

export const REAL_AGENT_BROWSER_CMD = crlf([
  '@ECHO off',
  '"%~dp0node_modules\\agent-browser\\bin\\agent-browser-win32-x64.exe" %*'
])

// Extensionless targets need cmd PATHEXT resolution and must not resolve directly.
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

export const REAL_PNPM_CMD = crlf([
  '@SETLOCAL',
  '@"%~dp0\\..\\global\\v11\\27d0-19f7df4c136-1fab7163f1a52461\\node_modules\\@pnpm\\exe\\pnpm.exe"   %*'
])

// A bare PATH alias has no shim-relative target to resolve.
export const REAL_PN_CMD = crlf(['@echo off', 'pnpm %*'])

export function npmProgNodeShim(scriptRelative: string): string {
  return REAL_CODEX_CMD.replace('node_modules\\@openai\\codex\\bin\\codex.js', scriptRelative)
}

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

export function npmDirectShim(targetRelative: string): string {
  return crlf(['@ECHO off', `"%~dp0${targetRelative}" %*`])
}
