import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CommitMessagePlan } from '../../../../shared/source-control/ai/generation/commit-message-plan'
import { buildPosixStdoutFence } from '../../../../shared/shell/launch/posix-stdout-fence'
import {
  buildPosixModelProbeCommand,
  buildWindowsModelProbeCommand,
  posixProbeEnvPrefix,
  powershellProbeEnvStatements
} from './ssh-model-probe-command'

const plan: CommitMessagePlan = {
  binary: 'claude',
  args: ['models'],
  stdinPayload: null,
  label: 'Claude',
  env: {
    'orca.review': 'ok',
    'FOO;id': '1',
    'a$(whoami)': '2',
    "a'b": '3',
    ANTHROPIC_BASE_URL: 'https://gateway.example'
  }
}

function decodePowerShellCommand(command: string): string {
  const marker = '-EncodedCommand '
  const encoded = command.slice(command.indexOf(marker) + marker.length)
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

describe('SSH model probe env commands', () => {
  it('passes dotted and metacharacter names to POSIX env as one quoted argument', () => {
    const prefix = posixProbeEnvPrefix(plan.env)
    expect(prefix.startsWith('env ')).toBe(true)
    expect(prefix).toContain("'orca.review=ok'")
    expect(prefix).toContain("'FOO;id=1'")
    expect(prefix).toContain("'a$(whoami)=2'")
    expect(prefix).toContain(`'a'\\''b=3'`)
    expect(prefix).toContain("'ANTHROPIC_BASE_URL=https://gateway.example'")
    expect(posixProbeEnvPrefix({ 'A=B': 'x', '': 'y' })).toBe('')
    const command = buildPosixModelProbeCommand('/srv/app', plan).command
    expect(command).toContain('env ')
    expect(command).toContain('orca.review=ok')
    expect(command).not.toContain('$env:')
  })

  it('sets PowerShell env with quoted .NET calls instead of $env:<name>', () => {
    const statements = powershellProbeEnvStatements(plan.env).join('\n')
    expect(statements).toContain(
      "[System.Environment]::SetEnvironmentVariable('orca.review', 'ok', 'Process')"
    )
    expect(statements).toContain(
      "[System.Environment]::SetEnvironmentVariable('FOO;id', '1', 'Process')"
    )
    expect(statements).toContain(
      "[System.Environment]::SetEnvironmentVariable('a$(whoami)', '2', 'Process')"
    )
    expect(statements).toContain(
      "[System.Environment]::SetEnvironmentVariable('a''b', '3', 'Process')"
    )
    expect(statements).not.toContain('$env:')
    expect(powershellProbeEnvStatements({ 'A=B': 'x' })).toEqual([])
    const decoded = decodePowerShellCommand(buildWindowsModelProbeCommand('C:\\repo', plan))
    expect(decoded).toContain("[System.Environment]::SetEnvironmentVariable('orca.review'")
    expect(decoded).toContain("'FOO;id'")
    expect(decoded).toContain("'a$(whoami)'")
    expect(decoded).toContain("'a''b'")
    expect(decoded).not.toContain('$env:')
  })

  it('refuses option-shaped POSIX names and quotes a multiline value', () => {
    expect(posixProbeEnvPrefix({ '-u': 'foo', '-u=foo': 'bar' })).toBe('')
    const prefix = posixProbeEnvPrefix({ MULTI: 'a\nb' })
    expect(prefix.startsWith('env ')).toBe(true)
    expect(prefix).toContain('MULTI')
  })

  it.skipIf(process.platform === 'win32')(
    'runs a multiline POSIX env value through /bin/sh',
    () => {
      const prefix = posixProbeEnvPrefix({ MULTI: 'a\nb' })
      const run = spawnSync('/bin/sh', ['-c', `${prefix} /bin/sh -c 'printf %s "$MULTI"'`], {
        encoding: 'utf8'
      })
      expect(run.status).toBe(0)
      expect(run.stdout).toBe('a\nb')
    }
  )

  it('quotes PowerShell curly quotes and clears an explicit empty string', () => {
    const statements = powershellProbeEnvStatements({
      ANTHROPIC_CUSTOM_HEADERS: 'it\u2019s a token',
      EMPTY: ''
    }).join('\n')
    expect(statements).toContain(`'it\u2019\u2019s a token'`)
    expect(statements).toContain(
      "[System.Environment]::SetEnvironmentVariable('EMPTY', $null, 'Process')"
    )
    expect(statements).not.toContain(", '', 'Process'")
    expect(statements).not.toContain('$env:')
  })

  it('stops on a missing cwd, escapes native quotes, skips npm .ps1 shims, and propagates exit codes', () => {
    for (const binary of [
      'claude',
      'claude.exe',
      'claude.cmd',
      'C:\\Users\\me\\AppData\\Roaming\\npm\\claude',
      'C:\\Tools\\[proj]\\claude',
      'C:\\Tools\\claude.cmd'
    ]) {
      const decoded = decodePowerShellCommand(
        buildWindowsModelProbeCommand('C:\\repo', {
          ...plan,
          binary,
          args: ['--settings', '{"disableAllHooks":true}']
        })
      )
      expect(decoded).toContain("Set-Location -ErrorAction Stop -LiteralPath 'C:\\repo'")
      expect(decoded).toContain('function Global:__OrcaEscapeNativeArgs')
      expect(decoded).toContain("-match '\\.(bat|cmd)$'")
      expect(decoded).toContain('$PSVersionTable.PSVersion.Major -lt 6')
      expect(decoded).toContain(`$OrcaProbeProgram = '${binary}'`)
      expect(decoded).toContain("if ($OrcaProbeProgram -match '[\\\\/]') {")
      expect(decoded).toContain("foreach ($OrcaProbeExt in @('.exe', '.cmd', '.bat', '.com')) {")
      expect(decoded).toContain('Test-Path -LiteralPath $OrcaProbeCandidate -PathType Leaf')
      expect(decoded).toContain(
        'Get-Command -Name $OrcaProbeProgram -CommandType Application -ErrorAction SilentlyContinue'
      )
      expect(decoded).toContain(`$OrcaProbeArgs = @('--settings', '{"disableAllHooks":true}')`)
      expect(decoded).toContain(
        '$OrcaProbeEscaped = @(__OrcaEscapeNativeArgs $OrcaProbeProgram $OrcaProbeArgs)'
      )
      expect(decoded).toContain(
        [
          '$global:LASTEXITCODE = $null',
          '& $OrcaProbeProgram @OrcaProbeEscaped',
          '$OrcaProbeOk = $?',
          'if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }',
          'if (-not $OrcaProbeOk) { exit 1 }'
        ].join('\n')
      )
      expect(decoded).not.toContain('ExternalScript')
      expect(decoded).not.toContain(`& '${binary}'`)
    }
  })
})

const echoPlan: CommitMessagePlan = {
  binary: '/bin/echo',
  args: ['PROBE_OK'],
  stdinPayload: null,
  label: 'Claude'
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

describe('POSIX SSH model probe login shell', () => {
  it('uses a POSIX login shell and sends every other shell to /bin/sh', () => {
    const command = buildPosixModelProbeCommand('/srv/app', plan).command
    expect(command).toContain('case "${SHELL##*/}" in')
    expect(command).toContain('sh|dash|bash|zsh|ksh|mksh|ash)')
    expect(command).toContain('"$SHELL" -lc')
    expect(command).toContain('/bin/sh -lc')
    expect(command).toContain('__ORCA_SSH_PROBE_CAPTURE_BEGIN_')
    expect(command).toContain('__ORCA_SSH_PROBE_CAPTURE_END_')
    expect(command).not.toContain('exec ')
  })

  it.skipIf(process.platform === 'win32' || !existsSync('/bin/bash'))(
    'drops a login-shell banner and still prints both end markers',
    () => {
      const home = mkdtempSync(join(tmpdir(), 'orca-probe-bash-'))
      try {
        writeFileSync(join(home, '.bash_profile'), "printf 'PROFILE_BANNER'")
        writeFileSync(join(home, '.bash_logout'), "printf 'LOGOUT_BANNER'")
        const built = buildPosixModelProbeCommand(home, echoPlan)
        const outer = buildPosixStdoutFence(built.command, 'SSH', 'outer')
        const run = spawnSync('/bin/sh', ['-c', outer.command], {
          encoding: 'utf8',
          env: { HOME: home, SHELL: '/bin/bash', PATH: '/bin:/usr/bin' }
        })
        const stdout = run.stdout ?? ''
        expect(run.status, run.stderr ?? '').toBe(0)
        expect(stdout).toContain('PROFILE_BANNER')
        expect(stdout).toContain('LOGOUT_BANNER')
        const probeEnd = stdout.indexOf(built.endMarker)
        const logoutAt = stdout.indexOf('LOGOUT_BANNER')
        const outerEnd = stdout.indexOf(outer.endMarker)
        expect(probeEnd).toBeGreaterThan(-1)
        expect(logoutAt).toBeGreaterThan(probeEnd)
        expect(outerEnd).toBeGreaterThan(logoutAt)
        const outerPayload = outer.readStdout(stdout)
        expect(outerPayload).toContain('PROFILE_BANNER')
        expect(built.readStdout(outerPayload ?? stdout)).toBe('PROBE_OK\n')
        expect(built.readStdout(outerPayload ?? stdout)).not.toContain('PROFILE_BANNER')
        expect(built.readStdout(outerPayload ?? stdout)).not.toContain('LOGOUT_BANNER')
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'runs fish, tcsh, csh, and nu probes through /bin/sh',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-probe-shells-'))
      const cwd = mkdtempSync(join(tmpdir(), 'orca-probe-cwd-'))
      try {
        mkdirSync(join(root, 'usr', 'bin'), { recursive: true })
        mkdirSync(join(root, 'bin'), { recursive: true })
        const shells = [
          join(root, 'usr', 'bin', 'fish'),
          join(root, 'bin', 'tcsh'),
          join(root, 'bin', 'csh'),
          join(root, 'usr', 'bin', 'nu')
        ]
        for (const shell of shells) {
          writeExecutable(shell, "#!/bin/sh\nprintf 'NONPOSIX_RAN'\nexit 9\n")
          const built = buildPosixModelProbeCommand(cwd, echoPlan)
          const outer = buildPosixStdoutFence(built.command, 'SSH', 'outer')
          const run = spawnSync('/bin/sh', ['-c', outer.command], {
            encoding: 'utf8',
            env: { HOME: cwd, SHELL: shell, PATH: '/bin:/usr/bin' }
          })
          const stdout = run.stdout ?? ''
          expect(run.status, `${shell}\n${run.stderr ?? ''}\n${stdout}`).toBe(0)
          expect(stdout).not.toContain('NONPOSIX_RAN')
          expect(stdout).toContain(built.endMarker)
          expect(stdout).toContain(outer.endMarker)
          expect(built.readStdout(outer.readStdout(stdout) ?? stdout)).toBe('PROBE_OK\n')
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
        rmSync(cwd, { recursive: true, force: true })
      }
    }
  )
})
