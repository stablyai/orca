import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NODE_RUNTIME_ASSETS, NODE_RUNTIME_PIN } from '../../shared/node-runtime-pin'
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import { uploadRelayDirectory } from './ssh-relay-install-transfers'
import {
  ensureRemoteOrcadNodeRuntime,
  probeRemoteNodeRuntimeCommand,
  remoteNodeRuntimeDir,
  remoteNodeRuntimePresentCommand,
  REMOTE_NODE_RUNTIME_MISSING,
  REMOTE_NODE_RUNTIME_READY,
  RemoteNodeRuntimeSecurityModifiedError,
  RemoteNodeRuntimeSelfTestError
} from './orcad-remote-node-runtime'
import {
  windowsNodeRuntimeProbeCommand,
  windowsNodeRuntimePromoteCommand,
  WINDOWS_NODE_RUNTIME_PROMOTE_TIMEOUT_MS
} from './orcad-remote-node-runtime-windows'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { decodeRemotePowerShellScript } from './ssh-remote-powershell'

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn() }))
vi.mock('./ssh-relay-install-transfers', () => ({ uploadRelayDirectory: vi.fn() }))

const host = getRemoteHostPlatform('win32-x64')
const target = 'win32-x64'
const asset = NODE_RUNTIME_ASSETS[target]
const relayDir = 'C:/Users/u/.orca-remote/relay-0.1.0+abcdef012345'
const runtimeDir = remoteNodeRuntimeDir(host, relayDir, target)
const stageDir = `C:/Users/u/.orca-remote/runtimes/.stage-node-${asset.executableSha256}-0011`
const conn = {} as SshConnection

function promoteScript(): string {
  return decodeRemotePowerShellScript(
    windowsNodeRuntimePromoteCommand({ stageDir, archive: asset.archive, runtimeDir, target })
  )
}

beforeEach(() => {
  vi.mocked(execCommand).mockReset()
  vi.mocked(uploadRelayDirectory).mockReset().mockResolvedValue(undefined)
})

describe('Windows runtime store layout', () => {
  it('sits under %USERPROFILE%\\.orca-remote\\runtimes beside the relay dirs', () => {
    expect(runtimeDir).toBe(`C:/Users/u/.orca-remote/runtimes/node-${asset.executableSha256}`)
    expect(path.win32.normalize(runtimeDir)).toBe(
      `C:\\Users\\u\\.orca-remote\\runtimes\\node-${asset.executableSha256}`
    )
  })
})

describe('Windows runtime store commands', () => {
  it('stays inside the EDR posture: one existing encoded powershell.exe line, no policy switch, no compilation', () => {
    const commands = [
      windowsNodeRuntimeProbeCommand(runtimeDir, target, stageDir),
      remoteNodeRuntimePresentCommand(host, runtimeDir),
      windowsNodeRuntimePromoteCommand({ stageDir, archive: asset.archive, runtimeDir, target })
    ]
    for (const command of commands) {
      expect(command).toMatch(/^powershell\.exe -NoProfile -NonInteractive -EncodedCommand \S+$/)
      const script = decodeRemotePowerShellScript(command)
      expect(script).not.toMatch(/ExecutionPolicy|Add-Type|\.ps1|Import-Module/)
      expect(script).not.toContain('bun')
    }
  })

  it('probes by hash under the marker and stages the upload in the same invocation', () => {
    expect(decodeRemotePowerShellScript(probeRemoteNodeRuntimeCommand(host, runtimeDir, target)))
      .toMatchInlineSnapshot(`
        "$ProgressPreference = 'SilentlyContinue'
        function Get-OrcaSha256([string]$p) { if (Test-Path -LiteralPath $p -PathType Leaf) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() } else { "" } }
        $runtimeDir = 'C:/Users/u/.orca-remote/runtimes/node-ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32'
        $exe = 'C:/Users/u/.orca-remote/runtimes/node-ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32/node.exe'
        $verified = 'C:/Users/u/.orca-remote/runtimes/node-ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32/.verified'
        if ((Get-OrcaSha256 $exe) -eq 'ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32') {
        if (Test-Path -LiteralPath $verified -PathType Leaf) { Write-Output 'ORCA_NODE_RUNTIME_READY'; exit 0 }
        try { $adoptOut = ((& $exe --version 2>&1) | ForEach-Object { "$_" }) -join ''; if (($LASTEXITCODE -eq 0) -and ($adoptOut.Trim() -eq 'v24.21.0')) { [IO.File]::WriteAllText($verified, ''); Write-Output 'ORCA_NODE_RUNTIME_READY'; exit 0 } } catch { }
        }
        Write-Output 'ORCA_NODE_RUNTIME_MISSING'"
      `)
    expect(
      decodeRemotePowerShellScript(windowsNodeRuntimeProbeCommand(runtimeDir, target, stageDir))
    ).toContain(`New-Item -ItemType Directory -Force -Path '${stageDir}' -ErrorAction Stop`)
  })

  it('adopts a pinned node.exe an earlier vault reader left without a marker, after running it', () => {
    const script = decodeRemotePowerShellScript(
      windowsNodeRuntimeProbeCommand(runtimeDir, target, stageDir)
    )
    const hashed = script.indexOf(`if ((Get-OrcaSha256 $exe) -eq '${asset.executableSha256}') {`)
    const ran = script.indexOf('& $exe --version')
    const marked = script.indexOf("[IO.File]::WriteAllText($verified, '')")
    expect(hashed).toBeGreaterThan(0)
    expect(ran).toBeGreaterThan(hashed)
    expect(marked).toBeGreaterThan(ran)
    expect(script).toContain(`($adoptOut.Trim() -eq 'v${NODE_RUNTIME_PIN.version}')`)
  })

  it('checks only the marker and node.exe on the warm path', () => {
    const script = decodeRemotePowerShellScript(remoteNodeRuntimePresentCommand(host, runtimeDir))
    expect(script).not.toContain('Get-FileHash')
    expect(script).toContain(`${runtimeDir}/node.exe`)
  })

  it('verifies the zip, extracts node.exe with System32 tar.exe and falls back to Expand-Archive', () => {
    const script = promoteScript()
    expect(script).toContain(`-ne '${asset.archiveSha256}'`)
    expect(script).toContain("Join-Path $env:SystemRoot 'System32\\tar.exe'")
    expect(script).toContain(
      `& $tar -xf $archive -C $stage 'node-v${NODE_RUNTIME_PIN.version}-win-x64/node.exe'`
    )
    expect(script.indexOf('& $tar')).toBeLessThan(script.indexOf('Expand-Archive'))
    expect(script).toContain(
      `$extracted = '${stageDir}/node-v${NODE_RUNTIME_PIN.version}-win-x64/node.exe'`
    )
    expect(script).toContain(`$pin = '${asset.executableSha256}'`)
  })

  it('runs node.exe before publishing, and publishes node.exe plus .verified with one directory rename', () => {
    const script = promoteScript()
    const ran = script.indexOf('& $extracted --version')
    const moved = script.indexOf('[IO.Directory]::Move($candidate, $runtimeDir)')
    expect(ran).toBeGreaterThan(0)
    expect(moved).toBeGreaterThan(ran)
    expect(script).toContain(`-ne 'v${NODE_RUNTIME_PIN.version}'`)
    expect(script.indexOf("(Join-Path $candidate '.verified')")).toBeLessThan(moved)
    expect(script).toContain("(Join-Path $candidate 'node.exe')")
  })

  it('reports bytes that change after they were verified as security software, at every step', () => {
    const script = promoteScript()
    for (const step of [
      'the uploaded archive changed after it was written',
      'node.exe vanished after extraction',
      'node.exe changed after extraction',
      'node.exe changed after it ran',
      'node.exe changed after it was published'
    ]) {
      expect(script).toContain(`Write-Output 'ORCA_NODE_RUNTIME_SECURITY_MODIFIED ${step}'`)
    }
    // A post-publish change must not leave a marker the warm path would trust.
    expect(script).toMatch(
      /Remove-Item -LiteralPath \$verified -Force -ErrorAction SilentlyContinue; Write-Output 'ORCA_NODE_RUNTIME_SECURITY_MODIFIED node\.exe changed after it was published'/
    )
  })

  it('removes the stage after every outcome without exiting past the cleanup', () => {
    const script = promoteScript()
    const body = script.slice(
      script.indexOf('function Invoke-OrcaPromote'),
      script.indexOf('try { Invoke-OrcaPromote }')
    )
    expect(body).not.toMatch(/\bexit\b/)
    expect(script.trimEnd().split('\n').slice(-2)).toEqual([
      'Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue',
      'exit $script:code'
    ])
  })

  it('fits the command-line budget sshd hands to cmd.exe', () => {
    expect(
      windowsNodeRuntimePromoteCommand({ stageDir, archive: asset.archive, runtimeDir, target })
        .length
    ).toBeLessThanOrEqual(8_000)
  })
})

describe('ensureRemoteOrcadNodeRuntime on Windows', () => {
  const archivePath = async (): Promise<string> => {
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const dir = await mkdtemp(path.join(tmpdir(), 'win-runtime-archive-'))
    const file = path.join(dir, asset.archive)
    await writeFile(file, 'zip bytes')
    return file
  }

  it('returns after one unwrapped probe when the runtime is verified', async () => {
    vi.mocked(execCommand).mockResolvedValueOnce(`${REMOTE_NODE_RUNTIME_READY}\r\n`)
    await ensureRemoteOrcadNodeRuntime({ conn, host, slotDir: relayDir, target, archivePath })
    expect(execCommand).toHaveBeenCalledTimes(1)
    expect(vi.mocked(execCommand).mock.calls[0][2]).toMatchObject({ wrapCommand: false })
    expect(uploadRelayDirectory).not.toHaveBeenCalled()
  })

  /** Answers the probe, the store lock and the promote script by what each script does. */
  function answer(promote: string, reprobe = REMOTE_NODE_RUNTIME_MISSING): string[] {
    const scripts: string[] = []
    let probes = 0
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      const script = decodeRemotePowerShellScript(command)
      scripts.push(script)
      if (script.includes('.store-lock') && script.includes('CreateNew')) {
        return 'OK'
      }
      if (script.includes('Invoke-OrcaPromote')) {
        return promote
      }
      if (script.includes(REMOTE_NODE_RUNTIME_MISSING)) {
        return ++probes === 1 ? REMOTE_NODE_RUNTIME_MISSING : reprobe
      }
      return ''
    })
    return scripts
  }

  it('uploads into the stage the probe created and promotes under the store lock with a long budget', async () => {
    const scripts = answer(`extracted-by tar\r\n${REMOTE_NODE_RUNTIME_READY}\r\n`)
    await ensureRemoteOrcadNodeRuntime({ conn, host, slotDir: relayDir, target, archivePath })
    const calls = vi.mocked(execCommand).mock.calls
    for (const call of calls) {
      expect(call[1]).toMatch(/^powershell\.exe /)
      expect(call[2]).toMatchObject({ wrapCommand: false })
    }
    const stage = /New-Item -ItemType Directory -Force -Path '([^']+)'/.exec(scripts[0])?.[1]
    expect(stage).toMatch(
      /^C:\/Users\/u\/\.orca-remote\/runtimes\/\.stage-node-[0-9a-f]{64}-[0-9a-f]{16}$/
    )
    expect(vi.mocked(uploadRelayDirectory).mock.calls[0][2]).toBe(stage)
    const locked = scripts.findIndex((s) => s.includes('CreateNew'))
    const promoted = scripts.findIndex((s) => s.includes('Invoke-OrcaPromote'))
    const released = scripts.findIndex(
      (s) => s.startsWith('Remove-Item') && s.includes('.store-lock')
    )
    // Store GC collects on Windows too, so promotion holds the lock it takes (design D5).
    expect(locked).toBeGreaterThan(0)
    expect(promoted).toBeGreaterThan(locked)
    expect(released).toBeGreaterThan(promoted)
    expect(calls[promoted][2]).toMatchObject({ timeoutMs: WINDOWS_NODE_RUNTIME_PROMOTE_TIMEOUT_MS })
    // The promote script removes its own stage, so no separate cleanup runs.
    expect(scripts.some((s) => s.startsWith('Remove-Item') && s.includes('.stage-node-'))).toBe(
      false
    )
  })

  it('removes its stage when a sibling published the pin while this client uploaded', async () => {
    const scripts = answer('unused', REMOTE_NODE_RUNTIME_READY)
    await ensureRemoteOrcadNodeRuntime({ conn, host, slotDir: relayDir, target, archivePath })
    expect(scripts.some((s) => s.includes('Invoke-OrcaPromote'))).toBe(false)
    expect(scripts.at(-1)).toMatch(/^Remove-Item -LiteralPath '[^']*\.stage-node-/)
  })

  it('still removes the stage when the upload fails before promote runs', async () => {
    vi.mocked(execCommand).mockResolvedValueOnce(REMOTE_NODE_RUNTIME_MISSING).mockResolvedValue('')
    vi.mocked(uploadRelayDirectory).mockRejectedValueOnce(new Error('sftp write failed'))
    await expect(
      ensureRemoteOrcadNodeRuntime({ conn, host, slotDir: relayDir, target, archivePath })
    ).rejects.toThrow('sftp write failed')
    const calls = vi.mocked(execCommand).mock.calls
    expect(calls).toHaveLength(2)
    const stage = /New-Item -ItemType Directory -Force -Path '([^']+)'/.exec(
      decodeRemotePowerShellScript(calls[0][1])
    )?.[1]
    expect(decodeRemotePowerShellScript(calls[1][1])).toBe(
      `Remove-Item -LiteralPath '${stage}' -Recurse -Force -ErrorAction SilentlyContinue`
    )
  })

  it('surfaces a post-write change as a security-software verdict', async () => {
    answer('ORCA_NODE_RUNTIME_SECURITY_MODIFIED node.exe changed after it ran\r\n')
    const failure = await ensureRemoteOrcadNodeRuntime({
      conn,
      host,
      slotDir: relayDir,
      target,
      archivePath
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(RemoteNodeRuntimeSecurityModifiedError)
    expect(failure).toMatchObject({ detail: 'node.exe changed after it ran' })
  })

  it('carries what node.exe said when it would not run', async () => {
    answer(
      "ORCA_NODE_RUNTIME_SELFTEST_FAILED\r\nORCA_RUNTIME_EXIT=-1\r\nProgram 'node.exe' failed to run: This program is blocked by group policy.\r\n"
    )
    const failure = await ensureRemoteOrcadNodeRuntime({
      conn,
      host,
      slotDir: relayDir,
      target,
      archivePath
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(RemoteNodeRuntimeSelfTestError)
    expect(failure).toMatchObject({
      exitStatus: -1,
      output: expect.stringContaining('blocked by group policy')
    })
  })
})
