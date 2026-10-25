import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { scanSourceTree, stripComments } from '../../shared/source-scan/source-tree-scan'
import { powerShellCommand } from './ssh-remote-powershell'

function decodePayload(command: string): string {
  const encoded = command.match(/ -EncodedCommand (\S+)$/)?.[1]
  if (!encoded) {
    throw new Error(`no -EncodedCommand payload in: ${command}`)
  }
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

/** Remote Windows callers share these switches; preserve encoding while avoiding ineffective policy-bypass flags. */
describe('powerShellCommand', () => {
  it('spells no -ExecutionPolicy switch', () => {
    const command = powerShellCommand('exit 0')
    const switches = command.replace(/ -EncodedCommand \S+$/, '')

    // Encoded inline code is not execution-policy gated; Bypass adds EDR risk without changing execution.
    expect(switches).not.toMatch(/-ExecutionPolicy/i)
    expect(switches).not.toMatch(/Bypass/i)
    expect(switches).toBe('powershell.exe -NoProfile -NonInteractive')
  })

  it('keeps the base64 payload the remote shell cannot rewrite', () => {
    // sshd reparses through DefaultShell, often cmd.exe; encoded payload protects arbitrary shell characters.
    const command = powerShellCommand("Write-Output 'a & b' | Out-String")

    expect(command).toMatch(
      /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/
    )
    expect(decodePayload(command)).toBe("Write-Output 'a & b' | Out-String")
  })
})

const MAIN_DIR = join(import.meta.dirname, '..')

// Scan code with quote-aware stripComments for policy-gated file loading. Match case-insensitively with violation/near-miss fixtures; variable-only script paths remain outside source-scan coverage.
const POLICY_GATED_CONSTRUCTS = [
  {
    label: 'a PowerShell script file (.ps1/.psm1)',
    pattern: /\.psm?1\b/i,
    catches: [
      `powerShellCommand("$script = 'C:\\tools\\deploy.ps1'")`,
      `powerShellCommand("Import-Module '$dir\\orca.psm1'")`,
      `powerShellCommand("& '$root\\DEPLOY.PS1'")`
    ],
    ignores: [`const build = 'artifact.ps10'`]
  },
  {
    label: 'Import-Module',
    pattern: /\bImport-Module\b/i,
    catches: [
      `powerShellCommand("Import-Module 'NetSecurity'")`,
      `powerShellCommand("import-module $modulePath")`
    ],
    ignores: [`const name = 'Import-ModuleList'`]
  },
  {
    // Token-bound -File must not match real --credential-file/--log-file/--body-file arguments.
    label: 'the -File switch',
    pattern: /(^|[\s'"`([{,])-File\b/i,
    catches: [
      `runRemote("powershell.exe -NoProfile -File 'C:\\x.ps1'")`,
      `runRemote("powershell.exe  -file   $scriptVar")`,
      `runRemote(["-NoProfile", "-File", scriptVar])`
    ],
    ignores: [`fetchWith("--credential-file", path)`, `run("--log-file $p --body-file $b")`]
  },
  {
    // Generated dot-source payloads can begin at a TS quote/backtick, not only after semicolon.
    label: 'dot-sourcing',
    pattern: /(^|[;{'"`]|\n)[ \t]*\.[ \t]+['"$]/,
    catches: [
      `powerShellCommand(". '$profileScript'")`,
      `powerShellCommand("$ErrorActionPreference = 'Stop'; . '$profile'")`,
      `powerShellCommand(". $profileScript")`
    ],
    ignores: [
      `cp -a $sourcePath/. $destinationPath/`,
      `Host key verification failed for $displayHost. $detail`
    ]
  }
] as const

describe('remote PowerShell payload invariant', () => {
  // Reuse scanSourceTree exclusions so the ratchet's inventory cannot drift under a second walker.
  const importers = scanSourceTree(MAIN_DIR).filter((file) =>
    file.source.includes('ssh-remote-powershell')
  )

  it('finds the modules that build remote payloads', () => {
    // Require real importers so resolution changes cannot make every assertion vacuous.
    expect(importers.length).toBeGreaterThan(10)
  })

  it.each(POLICY_GATED_CONSTRUCTS)(
    'loads no remote payload through $label',
    ({ label, pattern }) => {
      const offenders = importers
        .filter((file) => pattern.test(stripComments(file.source)))
        .map((file) => file.relativePath)

      expect(
        offenders,
        `${offenders.join(', ')} uses ${label}, which IS execution-policy gated on the remote ` +
          'host. Do not restore `-ExecutionPolicy Bypass` to the command line (a GPO scope ' +
          'beats it). Set the policy in-payload at process scope instead — see the note on ' +
          'powerShellCommand.'
      ).toEqual([])
    }
  )

  // Use real generated spellings and near misses; pattern-shaped fixtures previously missed dot-source and overmatched --*-file.
  it.each(POLICY_GATED_CONSTRUCTS)(
    'detects $label wherever it is spelled',
    ({ pattern, catches, ignores }) => {
      for (const sample of catches) {
        expect(pattern.test(sample), `should catch: ${sample}`).toBe(true)
      }
      for (const sample of ignores) {
        expect(pattern.test(sample), `should ignore: ${sample}`).toBe(false)
      }
    }
  )
})
