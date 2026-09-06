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

/**
 * This one helper builds the command line for every remote-Windows SSH call site
 * (relay deploy, install locks, upload staging, GC claim, browse, CLI launch), so
 * its switches are worth pinning.
 */
describe('powerShellCommand', () => {
  it('spells no -ExecutionPolicy switch', () => {
    const command = powerShellCommand('exit 0')
    const switches = command.replace(/ -EncodedCommand \S+$/, '')

    // Why: `-EncodedCommand` is not execution-policy gated — only `-File` is — so the switch
    // was a no-op, and `-ExecutionPolicy Bypass` beside base64 is among the most heavily
    // EDR-flagged PowerShell command lines there is.
    expect(switches).not.toMatch(/-ExecutionPolicy/i)
    expect(switches).not.toMatch(/Bypass/i)
    expect(switches).toBe('powershell.exe -NoProfile -NonInteractive')
  })

  it('keeps the base64 payload the remote shell cannot rewrite', () => {
    // Why: this string is re-parsed by the remote host's sshd DefaultShell, which is
    // cmd.exe on a stock Windows OpenSSH install. Base64 is load-bearing here.
    const command = powerShellCommand("Write-Output 'a & b' | Out-String")

    expect(command).toMatch(
      /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/
    )
    expect(decodePayload(command)).toBe("Write-Output 'a & b' | Out-String")
  })
})

const MAIN_DIR = join(import.meta.dirname, '..')

// Why: execution policy gates loading script FILES and nothing else, so dropping
// `-ExecutionPolicy Bypass` is a no-op exactly while no remote payload loads one. That
// invariant is what makes the switch safe to omit, and it was previously guarded by nothing:
// a future payload that dot-sourced or used `-File` would fail only on a remote host whose
// LocalMachine policy is Restricted/AllSigned. See the invariant note on `powerShellCommand`.
// Every pattern is case-insensitive: PowerShell switches and cmdlet names are, and Windows
// paths are, so `-file`, `import-module` and `DEPLOY.PS1` are all legitimate spellings that a
// case-sensitive pattern would wave through. Verified to add no false positive across the real
// importers. Each entry carries the fixtures it must catch AND the near-misses it must not, so
// a future tightening cannot quietly trade one for the other.
//
// Limit: this is a source-text scan, so a script file reached only through a variable
// (`& $scriptPath`) never appears in source and no pattern here can catch it — this narrows
// the hole rather than sealing it. The invariant note on `powerShellCommand` covers the rest.
//
// Matched against `stripComments`, the shared quote-tracking stripper, so a construct named in
// prose is not counted as code. A line-anchored regex pair cannot do this job: it either eats
// live code by pairing a `/*` inside a glob string with a later comment close, or — anchoring
// to avoid that — skips every trailing comment. Quote state is the only fix.
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
    // Anchored to a token boundary: a bare /-File\b/i also matches `--credential-file`,
    // `--log-file` and `--body-file`, which are real arguments in three of these importers.
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
    // The quote/backtick prefixes matter: a dot-source in a generated payload usually sits at
    // the very start of a TS string literal — `powerShellCommand(". '$x'")` — not after a `;`.
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
  // `scanSourceTree` is the shared walk: it skips node_modules/dist/out/build/.git,
  // dot-directories and `__fixtures__`, and excludes tests by the shared `isTestFile` (which
  // also covers `.spec.ts`, `__tests__/` and `-test-harness.ts`). A hand-rolled walk that got
  // any of those wrong would move the floor below, which is this guard's own goalpost.
  const importers = scanSourceTree(MAIN_DIR).filter((file) =>
    file.source.includes('ssh-remote-powershell')
  )

  it('finds the modules that build remote payloads', () => {
    // Guards the scan itself: a resolution change that emptied this list would make every
    // assertion below vacuously pass. 15 importers today, re-derived against the shared walk.
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

  // Why: these patterns only earn trust if they fire on a real violation spelled the way a
  // generated payload spells it — inside a TS string literal — and stay quiet on the near
  // misses. Both halves are load-bearing: an earlier dot-source pattern passed a `;`-prefixed
  // sample but missed `powerShellCommand(". '$x'")`, and the obvious case-insensitive fix for
  // `-File` matches `--credential-file` in three real importers. A fixture written from the
  // pattern confirms the pattern; these are written from the requirement.
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
