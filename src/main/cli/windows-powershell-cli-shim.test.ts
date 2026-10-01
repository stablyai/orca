import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  installWindowsPowerShellCliShim,
  ORCA_POWERSHELL_SHIM_BEGIN,
  ORCA_POWERSHELL_SHIM_END,
  profileHasUserOrcaFunction,
  removeWindowsPowerShellCliShim,
  renderOrcaPowerShellCliShim,
  shouldManageWindowsPowerShellCliShim,
  upsertManagedProfileBlock,
  windowsPowerShell51ProfilePath
} from './windows-powershell-cli-shim'

const UTF8_SERDTSE_CRLF = Buffer.from('Сердце\r\n', 'utf8')

describe('windows powershell cli shim', () => {
  it('turns the shim on only for an unconfigured production installer', () => {
    expect(shouldManageWindowsPowerShellCliShim({})).toBe(true)
    expect(shouldManageWindowsPowerShellCliShim({ platform: 'win32' })).toBe(false)
    expect(shouldManageWindowsPowerShellCliShim({ syncWindowsPowerShellProfile: true })).toBe(true)
  })

  it('keeps a user orca function and still replaces only the managed block', () => {
    const profile = "function orca { 'user' }\n"
    expect(profileHasUserOrcaFunction(profile)).toBe(true)
    expect(upsertManagedProfileBlock(profile, 'block')).toBe('skipped-user-function')
    const managed = `${ORCA_POWERSHELL_SHIM_BEGIN}\n. 'shim.ps1'\n# <<< orca cli utf-8 shim <<<\n`
    expect(upsertManagedProfileBlock(`Write-Host 'keep'\n\n${managed}`, 'NEXT')).toBe(
      "Write-Host 'keep'\n\nNEXT\n"
    )
  })

  it('preserves profile text outside the managed block', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ps-whitespace-'))
    const profilePath = windowsPowerShell51ProfilePath(root)
    await mkdir(join(root, 'WindowsPowerShell'), { recursive: true })
    const user = "Write-Host 'keep'   \n\n\nfunction other {}\n"
    await writeFile(profilePath, user, 'utf8')
    await removeWindowsPowerShellCliShim({
      documentsPath: root,
      shimPath: join(root, 'missing.ps1')
    })
    expect(await readFile(profilePath, 'utf8')).toBe(user)

    const managed = `${ORCA_POWERSHELL_SHIM_BEGIN}\n. 'shim.ps1'\n${ORCA_POWERSHELL_SHIM_END}\n`
    expect(upsertManagedProfileBlock(`${user}${managed}`, 'NEXT')).toBe(`${user}NEXT\n`)
  })

  it('refuses a launcher path that would break the profile script', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ps-newline-'))
    await expect(
      installWindowsPowerShellCliShim({
        launcherPath: 'C:\\Orca\\orca\r\n.exe',
        documentsPath: root,
        shimPath: join(root, 'shim.ps1')
      })
    ).rejects.toThrow(/newline/)
  })

  it('refuses to rewrite a profile that is not UTF-8 or UTF-16', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ps-profile-'))
    const profilePath = windowsPowerShell51ProfilePath(root)
    await mkdir(join(root, 'WindowsPowerShell'), { recursive: true })
    await writeFile(profilePath, Buffer.from([0xc0, 0x80]))
    const status = await installWindowsPowerShellCliShim({
      launcherPath: 'C:\\Orca\\orca.exe',
      documentsPath: root,
      shimPath: join(root, 'shim.ps1')
    })
    expect(status).toBe('skipped-undecodable-profile')
    expect(await readFile(profilePath)).toEqual(Buffer.from([0xc0, 0x80]))
  })

  it('renders a simple function that quotes the launcher path', () => {
    const script = renderOrcaPowerShellCliShim("C:\\Orca\\it's\\orca.exe")
    expect(script).toContain('function global:orca {')
    expect(script).toContain("$launcher = 'C:\\Orca\\it''s\\orca.exe'")
    expect(script).toContain('Orca CLI launcher is missing')
    expect(script).not.toContain('Get-Command')
    expect(script).not.toContain('[CmdletBinding(')
    expect(script).not.toContain('$global:OutputEncoding')
  })

  it.skipIf(process.platform !== 'win32')(
    'pipes Cyrillic to the launcher as UTF-8 and forwards args and the exit code',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-ps-shim-'))
      const shimPath = join(root, 'orca-powershell-shim.ps1')
      const pipeStub = join(root, 'pipe-stub.js')
      const argsStub = join(root, 'args-stub.js')
      const pipeOut = join(root, 'pipe.bin')
      const argsOut = join(root, 'args.txt')
      const pipeScript = join(root, 'pipe.ps1')
      const argsScript = join(root, 'args.ps1')
      await writeFile(
        pipeStub,
        [
          "const fs = require('node:fs')",
          'const chunks = []',
          "process.stdin.on('data', (chunk) => chunks.push(chunk))",
          "process.stdin.on('end', () => {",
          '  fs.writeFileSync(process.argv[2], Buffer.concat(chunks))',
          '  process.exit(Number(process.argv[3]))',
          '})',
          ''
        ].join('\n'),
        'utf8'
      )
      await writeFile(
        argsStub,
        [
          "const fs = require('node:fs')",
          "fs.writeFileSync(process.argv[2], process.argv.slice(3).join('|'))",
          'process.exit(7)',
          ''
        ].join('\n'),
        'utf8'
      )
      await installWindowsPowerShellCliShim({
        launcherPath: process.execPath,
        documentsPath: join(root, 'docs'),
        shimPath
      })
      await writeUtf8Bom(
        pipeScript,
        [
          `. ${psQuote(shimPath)}`,
          "@'",
          'Сердце',
          `'@ | orca ${psQuote(pipeStub)} ${psQuote(pipeOut)} 0 --current --body-file -`,
          'exit $LASTEXITCODE',
          ''
        ].join('\r\n')
      )
      await writeUtf8Bom(
        argsScript,
        [
          `. ${psQuote(shimPath)}`,
          `orca ${psQuote(argsStub)} ${psQuote(argsOut)} --current --body-file -`,
          'exit $LASTEXITCODE',
          ''
        ].join('\r\n')
      )

      expect(await runPowerShellFile(pipeScript)).toBe(0)
      expect(await readFile(pipeOut)).toEqual(UTF8_SERDTSE_CRLF)
      expect(await runPowerShellFile(argsScript)).toBe(7)
      expect(await readFile(argsOut, 'utf8')).toBe('--current|--body-file|-')

      await removeWindowsPowerShellCliShim({
        documentsPath: join(root, 'docs'),
        shimPath
      })
      await expect(readFile(shimPath)).rejects.toThrow()
    },
    30_000
  )
})

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function writeUtf8Bom(path: string, text: string): Promise<void> {
  return writeFile(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]))
}

function runPowerShellFile(scriptPath: string): Promise<number> {
  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true }
    )
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === null) {
        reject(new Error(stderr || 'powershell closed without a status'))
        return
      }
      if (code !== 0 && code !== 7) {
        reject(new Error(`powershell exited ${code}: ${stderr}`))
        return
      }
      resolve(code)
    })
  })
}
