import { afterEach, describe, expect, it } from 'vitest'
import { getManagedStatusLineScript } from './statusline-script'

const ORIGINAL_PLATFORM = process.platform

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: ORIGINAL_PLATFORM })
})

describe('getManagedStatusLineScript (posix)', () => {
  it('guards on rate_limits before sourcing the endpoint or spawning curl', () => {
    stubPlatform('darwin')
    const script = getManagedStatusLineScript('local')
    expect(script).toBe(getManagedStatusLineScript('posix'))
    const guardIndex = script.indexOf('*\'"rate_limits"\'*')
    const endpointIndex = script.indexOf('ORCA_AGENT_HOOK_ENDPOINT')
    const curlIndex = script.indexOf('curl -sS')
    expect(guardIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeLessThan(endpointIndex)
    expect(endpointIndex).toBeLessThan(curlIndex)
    expect(script).toContain('/statusline/claude')
    expect(script).toContain('--data-urlencode "payload@-"')
  })

  it('returns the posix script even on win32 when targeting a remote', () => {
    stubPlatform('win32')
    const script = getManagedStatusLineScript('posix')
    expect(script).toContain('#!/bin/sh')
    expect(script).not.toContain('curl.exe')
  })
})

describe('getManagedStatusLineScript (win32 local)', () => {
  it('guards on rate_limits via findstr before the endpoint call and curl spawn', () => {
    stubPlatform('win32')
    const script = getManagedStatusLineScript('local')
    const captureIndex = script.indexOf('more.com')
    // Why: the \"-escaped needle makes findstr match the quoted JSON key, not any path containing rate_limits.
    const guardIndex = script.indexOf('findstr.exe" /c:\\"rate_limits\\"')
    const endpointIndex = script.indexOf('call "%ORCA_AGENT_HOOK_ENDPOINT%"')
    const curlIndex = script.indexOf('curl.exe')
    expect(captureIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeGreaterThan(captureIndex)
    expect(guardIndex).toBeLessThan(endpointIndex)
    expect(endpointIndex).toBeLessThan(curlIndex)
    expect(script).toContain('if errorlevel 1 goto :orca_statusline_cleanup')
  })

  it('posts the buffered payload file and deletes it afterwards', () => {
    stubPlatform('win32')
    const script = getManagedStatusLineScript('local')
    // Why: the temp file is per-pane (pane key with ":" mapped to "_") because %RANDOM%
    // collides across cmd instances spawned in the same second.
    expect(script).toContain(
      'set "ORCA_STATUSLINE_PAYLOAD_FILE=%TEMP%\\orca-claude-statusline-%ORCA_PANE_KEY::=_%.tmp"'
    )
    expect(script).toContain('--data-urlencode "payload@%ORCA_STATUSLINE_PAYLOAD_FILE%"')
    expect(script).not.toContain('payload@-')
    const curlIndex = script.indexOf('curl.exe')
    const delIndex = script.indexOf('del "%ORCA_STATUSLINE_PAYLOAD_FILE%"')
    expect(delIndex).toBeGreaterThan(curlIndex)
  })

  it('never posts a literal %CLAUDE_CONFIG_DIR% token when the var is unset', () => {
    stubPlatform('win32')
    const script = getManagedStatusLineScript('local')
    // Why: the posted field comes from an always-defined variable so an unset
    // CLAUDE_CONFIG_DIR yields "configDir=" (matching POSIX + the null snapshot).
    expect(script).toContain('set "ORCA_STATUSLINE_CONFIG_DIR_FIELD=configDir="')
    expect(script).toContain(
      'if defined CLAUDE_CONFIG_DIR set "ORCA_STATUSLINE_CONFIG_DIR_FIELD=configDir=%CLAUDE_CONFIG_DIR%"'
    )
    expect(script).toContain('--data-urlencode "%ORCA_STATUSLINE_CONFIG_DIR_FIELD%"')
    expect(script).not.toContain('"configDir=%CLAUDE_CONFIG_DIR%"')
  })

  it('drains stdin before exiting when the pane key is missing', () => {
    stubPlatform('win32')
    const script = getManagedStatusLineScript('local')
    const paneGuardIndex = script.indexOf(
      'if "%ORCA_PANE_KEY%"=="" goto :orca_agent_hook_drain_stdin'
    )
    const captureIndex = script.indexOf('more.com')
    expect(paneGuardIndex).toBeGreaterThan(-1)
    expect(paneGuardIndex).toBeLessThan(captureIndex)
    expect(script).toContain(':orca_agent_hook_drain_stdin')
  })
})
