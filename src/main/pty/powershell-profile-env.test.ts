import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetPowerShellProfileEnvCache,
  readPowerShellProfileEnvValues,
  UNEVALUABLE_PROFILE_VALUE
} from './powershell-profile-env'

const { registryDocumentsDir } = vi.hoisted(() => {
  const state: { value?: string } = {}
  return { registryDocumentsDir: state }
})

// Why: the Documents known folder comes from the registry, absent off Windows.
vi.mock('../windows-native-registry', () => ({
  loadWindowsNativeRegistry: () => ({
    HK: { CU: 1, LM: 2 },
    getRegistryKey: () => ({ Personal: { value: registryDocumentsDir.value } })
  })
}))

let root: string

// Why: $PSHOME profiles hang off these, so the developer's real ones must not leak in.
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-ps-profile-'))
  vi.stubEnv('SystemRoot', join(root, 'Windows'))
  vi.stubEnv('ProgramFiles', join(root, 'pf'))
})

afterEach(() => {
  __resetPowerShellProfileEnvCache()
  vi.unstubAllEnvs()
  registryDocumentsDir.value = undefined
  rmSync(root, { recursive: true, force: true })
})

function writeProfile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

describe('readPowerShellProfileEnvValues', () => {
  it('keeps the last assignment each edition makes, $PSHOME loading first', () => {
    const userProfile = join(root, 'me')
    writeProfile(
      join(root, 'Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'profile.ps1'),
      "$env:CODEX_HOME = 'C:\\all-users'\n"
    )
    writeProfile(
      join(userProfile, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
      '\uFEFF$Env:Codex_Home="$HOME\\.codex-5"\r\n'
    )
    writeProfile(
      join(userProfile, 'Documents', 'PowerShell', 'profile.ps1'),
      '  ${env:CODEX_HOME} = $env:USERPROFILE\\.codex-7 # pwsh\n'
    )

    expect(readPowerShellProfileEnvValues('CODEX_HOME', userProfile)).toEqual([
      `${userProfile}\\.codex-5`,
      `${userProfile}\\.codex-7`
    ])
  })

  it('reads UTF-16LE profiles written by Windows PowerShell 5.1', () => {
    const profilePath = join(root, 'Documents', 'WindowsPowerShell', 'profile.ps1')
    writeProfile(profilePath, '')
    writeFileSync(
      profilePath,
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("$env:CODEX_HOME = 'C:\\utf16'\r\n", 'utf16le')
      ])
    )

    expect(readPowerShellProfileEnvValues('CODEX_HOME', root)).toEqual(['C:\\utf16'])
  })

  it('reads the registry-named Documents folder, e.g. one OneDrive redirected', () => {
    const documentsDir = join(root, 'OneDrive', 'Dokumente')
    registryDocumentsDir.value = documentsDir
    // PowerShell loads only the redirected folder, so a stale default is ignored.
    writeProfile(
      join(root, 'me', 'Documents', 'PowerShell', 'profile.ps1'),
      "$env:CODEX_HOME = 'C:\\stale'\n"
    )
    writeProfile(
      join(documentsDir, 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
      "$env:CODEX_HOME = 'D:\\codex'\n"
    )

    expect(readPowerShellProfileEnvValues('CODEX_HOME', join(root, 'me'))).toEqual(['D:\\codex'])
  })

  it('keeps literal and unevaluable values, and ignores other names and comments', () => {
    writeProfile(
      join(root, 'Documents', 'WindowsPowerShell', 'profile.ps1'),
      [
        "$env:CODEX_HOME = '$HOME\\literal # kept'",
        "$env:CODEX_HOMEX = 'C:\\other'",
        "# $env:CODEX_HOME = 'C:\\commented'"
      ].join('\n')
    )
    writeProfile(
      join(root, 'Documents', 'PowerShell', 'profile.ps1'),
      '$env:CODEX_HOME = (Join-Path $HOME .codex)\n'
    )

    expect(readPowerShellProfileEnvValues('CODEX_HOME', root)).toEqual([
      '$HOME\\literal # kept',
      UNEVALUABLE_PROFILE_VALUE
    ])
  })

  it('lets a later profile reset or clear what an earlier one set', () => {
    writeProfile(
      join(root, 'Documents', 'WindowsPowerShell', 'profile.ps1'),
      "$env:CODEX_HOME = 'C:\\custom'\n"
    )
    writeProfile(
      join(root, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
      '$env:CODEX_HOME = "$HOME\\.codex"\n'
    )
    writeProfile(
      join(root, 'Documents', 'PowerShell', 'profile.ps1'),
      ["$env:CODEX_HOME = 'C:\\custom'", '$env:CODEX_HOME = $null'].join('\n')
    )

    expect(readPowerShellProfileEnvValues('CODEX_HOME', root)).toEqual([`${root}\\.codex`])
  })

  it.each([
    ["Set-Item -Path env:CODEX_HOME -Value 'C:\\set-item'", 'C:\\set-item'],
    ['Set-Item Env:\\CODEX_HOME "$HOME\\set-item"', 'HOME\\set-item'],
    ["New-Item -Path Env:\\CODEX_HOME -Value 'C:\\new-item'", 'C:\\new-item'],
    ['New-Item env:CODEX_HOME C:\\bare', 'C:\\bare'],
    ["$env:CODEX_HOME = 'C:\\semicolon';", 'C:\\semicolon'],
    ["[Environment]::SetEnvironmentVariable('CODEX_HOME', 'C:\\dotnet')", 'C:\\dotnet'],
    [
      "[System.Environment]::SetEnvironmentVariable('CODEX_HOME', 'C:\\dotnet') # note",
      'C:\\dotnet'
    ],
    ["[Environment]::SetEnvironmentVariable('CODEX_HOME', 'C:\\dotnet', 'User')", 'C:\\dotnet'],
    ["[Environment]::SetEnvironmentVariable('CODEX_HOME', 'C:\\a,b', 'Process');", 'C:\\a,b'],
    [
      "[Environment]::SetEnvironmentVariable('CODEX_HOME', (Join-Path $HOME '.codex'), 'User')",
      UNEVALUABLE_PROFILE_VALUE
    ],
    ['$env:CODEX_HOME = "$env:LOCALAPPDATA\\..\\.codex"', UNEVALUABLE_PROFILE_VALUE]
  ])('reads %s', (line, expected) => {
    writeProfile(join(root, 'Documents', 'PowerShell', 'profile.ps1'), `${line}\n`)

    const [value] = readPowerShellProfileEnvValues('CODEX_HOME', root)
    expect(value?.replace(root, 'HOME')).toBe(expected)
  })

  it.each([
    '$env:CODEX_HOME = $null;',
    "[Environment]::SetEnvironmentVariable('CODEX_HOME', $null)"
  ])('reads %s as clearing an earlier value', (line) => {
    writeProfile(
      join(root, 'Documents', 'PowerShell', 'profile.ps1'),
      ["$env:CODEX_HOME = 'C:\\custom'", line].join('\n')
    )

    expect(readPowerShellProfileEnvValues('CODEX_HOME', root)).toEqual([])
  })

  it.each([
    "if ($env:CODEX_HOME -eq 'C:\\other') { }",
    "$env:CODEX_HOME2 = 'C:\\other'",
    "$env:CODEX_HOME == 'C:\\other'"
  ])('does not read %s as an assignment', (line) => {
    writeProfile(
      join(root, 'Documents', 'PowerShell', 'profile.ps1'),
      ["$env:CODEX_HOME = 'C:\\kept'", line].join('\n')
    )

    expect(readPowerShellProfileEnvValues('CODEX_HOME', root)).toEqual(['C:\\kept'])
  })
})
