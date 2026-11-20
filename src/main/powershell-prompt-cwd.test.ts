import { runProcess } from '@orca/process-host'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTreeSync } from '../shared/file-write/windows-transient-lock-removal'
import { encodePowerShellCommand } from '../shared/shell/launch/powershell-command-encoding'
import { getPowerShellOsc133Bootstrap } from './pty/shell-startup/powershell-osc133-bootstrap'
import { resolveWindowsPowerShellExecutablePath } from './providers/shell-launch/windows/powershell-executable'

const directories: string[] = []
const osc7 = new RegExp(
  `${String.fromCharCode(27)}\\]7;([^${String.fromCharCode(7)}]*)${String.fromCharCode(7)}`,
  'g'
)

afterEach(() => {
  for (const directory of directories.splice(0)) {
    removeTreeSync(directory)
  }
})

describe.skipIf(process.platform !== 'win32')('PowerShell live prompt directory', () => {
  it('publishes changed directories, escapes paths, and preserves failure status', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-prompt-cwd-'))
    directories.push(root)
    const nested = join(root, "space #中文%'quote")
    mkdirSync(nested)
    const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
    const script = `
function Global:prompt { "USER_PROMPT_SUCCESS=$?;" }
${getPowerShellOsc133Bootstrap()}
Set-Location -LiteralPath ${quote(root)}
[Console]::Write((prompt))
Set-Location -LiteralPath ${quote(nested)}
$global:LASTEXITCODE = 37
Write-Error 'expected failure' -ErrorAction Ignore
[Console]::Write((prompt))
[Console]::Write("LAST_EXIT=$global:LASTEXITCODE;")
Set-Location -LiteralPath 'Env:'
[Console]::Write((prompt))
`
    const program = resolveWindowsPowerShellExecutablePath('powershell.exe')
    if (!program) {
      throw new Error('Windows PowerShell executable was not found.')
    }
    const result = await runProcess({
      program,
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        encodePowerShellCommand(script)
      ],
      timeoutMs: 15000
    })

    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    const publishedDirectories = [...result.stdout.matchAll(osc7)].map((match) => match[1])
    expect(publishedDirectories).toEqual([pathToFileURL(root).href, pathToFileURL(nested).href])
    expect(result.stdout).toContain('USER_PROMPT_SUCCESS=False;')
    expect(result.stdout).toContain('LAST_EXIT=37;')
    expect(result.stdout).toContain('\x1b]133;D;1\x07')
  })
})
