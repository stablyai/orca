import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRemoteCliInstallPlan } from './ssh-remote-cli-launcher'
import { getRemoteHostPlatform } from './ssh-remote-platform'

// Why: cold csc.exe startup exceeds Vitest's 5s unit budget on hosted Windows;
// keep the larger allowance scoped to the real compiler integration test.
function itWindows(name: string, test: () => void): void {
  const runner = process.platform === 'win32' ? it : it.skip
  runner(name, { timeout: 15_000 }, test)
}

function decodePowerShellCommand(command: string): string {
  const encoded = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)?.[1]
  if (!encoded) {
    throw new Error(`Expected an encoded PowerShell command: ${command}`)
  }
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

describe('SSH remote MCode CLI launcher', () => {
  function windowsInstallPlan(): ReturnType<typeof createRemoteCliInstallPlan> {
    return createRemoteCliInstallPlan({
      binDir: 'C:/Users/me user/.mcode-relay/bin',
      relayDir: 'C:/Users/me user/.mcode-remote/relay-v1',
      nodePath: 'C:/Program Files/nodejs/node.exe',
      sockPath: '\\\\.\\pipe\\mcode-relay-123',
      credentialFile: 'C:/Users/me user/.mcode-remote/relay-v1/relay.sock.credential',
      hostPlatform: getRemoteHostPlatform('win32-x64')
    })
  }

  it('compiles a native Windows launcher without a cmd.exe argument bridge', () => {
    const plan = windowsInstallPlan()

    expect(plan.launcherPath).toBe('C:/Users/me user/.mcode-relay/bin/mcode.exe')
    expect(plan.files).toHaveLength(1)
    expect(plan.files[0]?.path).toBe('C:/Users/me user/.mcode-relay/bin/mcode-launcher.cs')
    expect(plan.files[0]?.contents).toContain('ProcessStartInfo')
    expect(plan.files[0]?.contents).toContain('"--mcode-cli"')
    expect(plan.files[0]?.contents).toContain('socketPath + ".credential"')
    expect(plan.files[0]?.contents).toContain("value[index] == '\"'")
    expect(plan.files[0]?.contents).toContain("character == '\\\\'")
    expect(plan.files[0]?.contents).not.toContain('cmd.exe')
    expect(plan.files[0]?.contents).not.toContain('%*')

    expect(plan.postWriteCommands).toHaveLength(1)
    const compileScript = decodePowerShellCommand(plan.postWriteCommands[0] ?? '')
    expect(compileScript).toContain('v4.0.30319\\csc.exe')
    // Why: legacy csc.exe is invoked from the bin directory with bare, space-free
    // file names so PowerShell 5.1 never mangles a space-bearing absolute path.
    expect(compileScript).toContain(
      "Set-Location -ErrorAction Stop -LiteralPath 'C:/Users/me user/.mcode-relay/bin'"
    )
    expect(compileScript).toContain('/out:mcode.exe')
    expect(compileScript).toContain('C:/Users/me user/.mcode-relay/bin/mcode-launcher.cs')
    expect(compileScript).toContain('C:/Users/me user/.mcode-relay/bin/mcode.cmd')
  })

  it('removes the legacy mcode.cmd only after every compile guard has passed', () => {
    const script = decodePowerShellCommand(windowsInstallPlan().postWriteCommands[0] ?? '')
    const legacyShimRemoval =
      "Remove-Item -LiteralPath 'C:/Users/me user/.mcode-relay/bin/mcode.cmd' -Force -ErrorAction SilentlyContinue"
    // Why: a host missing csc.exe or failing the compile must keep its existing
    // CLI, so every fail-closed guard precedes the legacy %* shim removal.
    const guards = [
      "if (-not $compiler) { Write-Error 'Unable to find the .NET Framework C# compiler required for the MCode SSH CLI launcher.'; exit 1 }",
      'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      "if (-not (Test-Path -LiteralPath 'C:/Users/me user/.mcode-relay/bin/mcode.exe' -PathType Leaf))"
    ]
    expect(script).toContain(legacyShimRemoval)
    for (const guard of guards) {
      expect(script).toContain(guard)
      expect(script.indexOf(guard)).toBeLessThan(script.indexOf(legacyShimRemoval))
    }
  })

  itWindows('preserves a multiline argument through the compiled remote launcher', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcode remote cli '))
    try {
      const binDir = join(root, 'bin').replaceAll('\\', '/')
      const relayDir = join(root, 'relay').replaceAll('\\', '/')
      const sockPath = '\\\\.\\pipe\\mcode-relay-test'
      const credentialFile = `${relayDir}/relay.sock.credential`
      const plan = createRemoteCliInstallPlan({
        binDir,
        relayDir,
        nodePath: process.execPath,
        sockPath,
        credentialFile,
        hostPlatform: getRemoteHostPlatform('win32-x64')
      })
      for (const file of plan.files) {
        mkdirSync(dirname(file.path), { recursive: true })
        writeFileSync(file.path, file.contents, 'utf8')
      }

      const encoded = plan.postWriteCommands[0]?.match(/-EncodedCommand\s+(\S+)/)?.[1]
      expect(encoded).toBeTruthy()
      const compile = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          encoded!
        ],
        { encoding: 'utf8' }
      )
      expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0)

      mkdirSync(relayDir, { recursive: true })
      writeFileSync(
        join(relayDir, 'relay.js'),
        'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n',
        'utf8'
      )
      const body = 'line one\nline two & whoami\n"quoted" C:\\tail\\'
      const launched = spawnSync(
        plan.launcherPath,
        ['orchestration', 'send', '--body', body, '--json'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            MCODE_RELAY_NODE_PATH: process.execPath,
            MCODE_RELAY_DIR: relayDir,
            MCODE_RELAY_SOCKET_PATH: sockPath,
            MCODE_RELAY_CREDENTIAL_FILE: credentialFile
          }
        }
      )

      expect(launched.status, launched.stderr).toBe(0)
      expect(JSON.parse(launched.stdout)).toEqual([
        '--sock-path',
        sockPath,
        '--credential-file',
        credentialFile,
        '--mcode-cli',
        'orchestration',
        'send',
        '--body',
        body,
        '--json'
      ])

      const defaulted = spawnSync(plan.launcherPath, ['status'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          MCODE_RELAY_NODE_PATH: process.execPath,
          MCODE_RELAY_DIR: relayDir,
          MCODE_RELAY_SOCKET_PATH: sockPath,
          MCODE_RELAY_CREDENTIAL_FILE: ''
        }
      })
      expect(defaulted.status, defaulted.stderr).toBe(0)
      expect(JSON.parse(defaulted.stdout)).toEqual([
        '--sock-path',
        sockPath,
        '--credential-file',
        `${sockPath}.credential`,
        '--mcode-cli',
        'status'
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  itWindows('preserves the existing mcode.cmd when the compiler is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcode remote cli '))
    try {
      const binDir = join(root, 'bin').replaceAll('\\', '/')
      mkdirSync(binDir, { recursive: true })
      const legacyShimPath = join(binDir, 'mcode.cmd')
      writeFileSync(legacyShimPath, '@echo legacy mcode cli\r\n', 'utf8')

      const plan = createRemoteCliInstallPlan({
        binDir,
        relayDir: join(root, 'relay').replaceAll('\\', '/'),
        nodePath: process.execPath,
        sockPath: '\\\\.\\pipe\\mcode-relay-test',
        credentialFile: join(root, 'relay', 'relay.sock.credential').replaceAll('\\', '/'),
        hostPlatform: getRemoteHostPlatform('win32-x64')
      })
      for (const file of plan.files) {
        mkdirSync(dirname(file.path), { recursive: true })
        writeFileSync(file.path, file.contents, 'utf8')
      }

      const encoded = plan.postWriteCommands[0]?.match(/-EncodedCommand\s+(\S+)/)?.[1]
      expect(encoded).toBeTruthy()
      // Point WINDIR at a directory with no csc.exe so compiler discovery fails.
      const compile = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          encoded!
        ],
        { encoding: 'utf8', env: { ...process.env, WINDIR: root, SystemRoot: root } }
      )

      expect(compile.status).not.toBe(0)
      expect(existsSync(legacyShimPath), 'existing mcode.cmd must survive a failed install').toBe(
        true
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the POSIX launcher as an argv-preserving shell exec', () => {
    const plan = createRemoteCliInstallPlan({
      binDir: '/home/me/.mcode-relay/bin',
      relayDir: '/home/me/.mcode-remote/relay-v1',
      nodePath: '/usr/bin/node',
      sockPath: '/home/me/.mcode-remote/relay-v1/relay.sock',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    expect(plan.launcherPath).toBe('/home/me/.mcode-relay/bin/mcode')
    expect(plan.files).toEqual([
      expect.objectContaining({
        path: '/home/me/.mcode-relay/bin/mcode',
        contents: expect.stringContaining('--mcode-cli "$@"')
      })
    ])
  })
})
