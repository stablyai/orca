import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import { NODE_RUNTIME_PIN } from '../../shared/node-runtime-pin'
import { RELAY_RUNTIME_SELF_TEST_PREFIX } from '../../shared/relay-runtime-self-test-report'
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import { SSH_EXEC_TIMEOUT_CODE } from './ssh-relay-exec-command'
import {
  classifyPinnedRuntimeFailure,
  evaluatePinnedRuntimeVersion,
  evaluateRelayRuntimeSelfTest,
  evaluateWindowsRelayRuntimeSelfTest,
  pinnedRuntimeVersionCommand,
  relayRuntimeSelfTestCommand,
  runPinnedRuntimeSelfTest,
  windowsRelayRuntimeSelfTestCommand
} from './ssh-relay-runtime-self-test'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { decodeRemotePowerShellScript } from './ssh-remote-powershell'

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn() }))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: All connection operations are mocked.
const conn = {} as SshConnection
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function sh(command: string): string {
  return runProcessSync({ program: '/bin/sh', args: ['-c', command], timeoutMs: 30_000 }).stdout
}

function report(nonce: string, fields: Record<string, unknown>): string {
  return `${RELAY_RUNTIME_SELF_TEST_PREFIX}${JSON.stringify({
    nonce,
    node: `v${NODE_RUNTIME_PIN.version}`,
    napi: '10',
    glibcVersionRuntime: '2.31',
    runtime: 'pinned-node',
    ...fields
  })}`
}

const NIXOS_STUB_LD_OUTPUT = [
  'Could not start dynamically linked executable: /home/u/.orca-remote/runtimes/node-x/bin/node',
  'NixOS cannot run dynamically linked executables intended for generic',
  'linux environments out of the box. For more information, see:',
  'https://nix.dev/permalink/stub-ld'
].join('\n')

describe('pinned runtime refusal classification', () => {
  it.each([
    [132, '', 'illegal_instruction'],
    [null, 'Illegal instruction (core dumped)', 'illegal_instruction'],
    [126, 'sh: 1: /home/u/.orca-remote/runtimes/node-x/bin/node: Permission denied', 'noexec'],
    [
      null,
      'Error: /r/node_modules/node-pty/build/Release/pty.node: failed to map segment from shared object',
      'noexec'
    ],
    [1, "node: /lib64/libc.so.6: version `GLIBC_2.28' not found (required by node)", 'libc_floor'],
    [1, "/lib64/libstdc++.so.6: version `GLIBCXX_3.4.26' not found", 'libc_floor'],
    [127, 'sh: /home/u/.orca-remote/runtimes/node-x/bin/node: not found', 'wrong_libc'],
    [null, 'Error relocating pty.node: __snprintf_chk: symbol not found', 'wrong_libc'],
    [
      1,
      'Error loading shared library ld-linux-x86-64.so.2: No such file or directory',
      'wrong_libc'
    ],
    [
      127,
      'node: error while loading shared libraries: libatomic.so.1: cannot open shared object file: No such file or directory',
      'missing_lib'
    ],
    // Alpine without libstdc++: musl lists every unresolved C++ symbol after the missing library.
    [
      127,
      [
        'Error loading shared library libstdc++.so.6: No such file or directory (needed by /root/.orca-remote/runtimes/node-x/bin/node)',
        'Error loading shared library libgcc_s.so.1: No such file or directory (needed by /root/.orca-remote/runtimes/node-x/bin/node)',
        'Error relocating /root/.orca-remote/runtimes/node-x/bin/node: _ZNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEE9_M_createERmm: symbol not found'
      ].join('\n'),
      'missing_lib'
    ]
  ])('classifies exit %j with %j as %s', (status, output, refusal) => {
    expect(classifyPinnedRuntimeFailure(status, output)).toBe(refusal)
  })

  it.each([
    [
      -1,
      "Program 'node.exe' failed to run: Operation did not complete successfully because the file contains a virus or potentially unwanted software",
      'security_software'
    ],
    [
      null,
      'bundled ConPTY file missing after upload: C:\\r\\node_modules\\node-pty\\build\\Release\\conpty\\OpenConsole.exe',
      'security_software'
    ],
    [-1, "Program 'node.exe' failed to run: This program is blocked by group policy.", 'noexec'],
    [
      -1,
      'Your organization used Device Guard to block this app. An Application Control policy has blocked this file.',
      'noexec'
    ]
  ])('classifies Windows exit %j with %j as %s', (status, output, refusal) => {
    expect(classifyPinnedRuntimeFailure(status, output)).toBe(refusal)
  })

  it('leaves an unrecognized failure unclassified', () => {
    expect(classifyPinnedRuntimeFailure(1, 'TypeError: something else')).toBeNull()
  })

  it("classifies NixOS's stub loader refusing a generic Linux binary as wrong_libc", () => {
    expect(classifyPinnedRuntimeFailure(127, NIXOS_STUB_LD_OUTPUT)).toBe('wrong_libc')
    // Only the loader's own exit; an unrelated 127 stays unclassified.
    expect(classifyPinnedRuntimeFailure(1, NIXOS_STUB_LD_OUTPUT)).toBeNull()
    expect(classifyPinnedRuntimeFailure(127, 'relay.js exited')).toBeNull()
  })
})

describe('self-test commands on a real shell', () => {
  function stage(): string {
    const root = mkdtempSync(join(tmpdir(), 'relay self test '))
    directories.push(root)
    return root
  }

  it('accepts only the pinned version from node --version', () => {
    const root = stage()
    const node = join(root, 'node')
    writeFileSync(node, `#!/bin/sh\necho v${NODE_RUNTIME_PIN.version}\n`, { mode: 0o755 })
    expect(evaluatePinnedRuntimeVersion(sh(pinnedRuntimeVersionCommand(node)))).toBeNull()

    writeFileSync(node, '#!/bin/sh\necho v18.20.0\n', { mode: 0o755 })
    expect(evaluatePinnedRuntimeVersion(sh(pinnedRuntimeVersionCommand(node)))).toMatchObject({
      verdict: 'failed'
    })
  })

  it('reports a non-executable runtime as noexec from the shell exit status', () => {
    const root = stage()
    const node = join(root, 'node')
    writeFileSync(node, '#!/bin/sh\necho v0\n', { mode: 0o644 })
    expect(evaluatePinnedRuntimeVersion(sh(pinnedRuntimeVersionCommand(node)))).toMatchObject({
      verdict: 'refused',
      refusal: 'noexec'
    })
  })

  it('runs relay.js with the self-test flag and nonce from the relay dir', () => {
    const root = stage()
    const relayDir = join(root, 'relay-0.1.0+abc')
    mkdirSync(relayDir)
    writeFileSync(
      join(relayDir, 'relay.js'),
      `const i = process.argv.indexOf('--orca-runtime-selftest');\n` +
        `console.log(${JSON.stringify(RELAY_RUNTIME_SELF_TEST_PREFIX)} + JSON.stringify({nonce: process.argv[i + 1], ok: true, cwd: process.cwd()}))\n`
    )
    const output = sh(relayRuntimeSelfTestCommand(relayDir, process.execPath, 'nonce-1'))
    const verdict = evaluateRelayRuntimeSelfTest(output, 'nonce-1')
    expect(verdict.verdict).toBe('passed')
    expect(evaluateRelayRuntimeSelfTest(output, 'other-nonce').verdict).toBe('failed')
  })

  it('classifies a relay process killed by SIGILL', () => {
    const root = stage()
    writeFileSync(join(root, 'relay.js'), "process.kill(process.pid, 'SIGILL')\n")
    const output = sh(relayRuntimeSelfTestCommand(root, process.execPath, 'n'))
    expect(evaluateRelayRuntimeSelfTest(output, 'n')).toMatchObject({
      verdict: 'refused',
      refusal: 'illegal_instruction'
    })
  })
})

describe('relay self-test report evaluation', () => {
  it('classifies the loader message a failed addon load reports', () => {
    const output = `ORCA_RUNTIME_EXIT=0\n${report('n', {
      ok: false,
      stage: 'load',
      error: "/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.33' not found"
    })}`
    expect(evaluateRelayRuntimeSelfTest(output, 'n')).toMatchObject({
      verdict: 'refused',
      refusal: 'libc_floor'
    })
  })

  it('never turns a PTY spawn failure into a runtime refusal', () => {
    const output = `ORCA_RUNTIME_EXIT=0\n${report('n', {
      ok: false,
      stage: 'spawn',
      error: 'posix_openpt: Permission denied'
    })}`
    expect(evaluateRelayRuntimeSelfTest(output, 'n').verdict).toBe('failed')
  })
})

describe('Windows relay self-test', () => {
  it('is one encoded powershell.exe line that runs relay.js on node.exe from the relay dir', () => {
    const command = windowsRelayRuntimeSelfTestCommand(
      'C:/Users/u/.orca-remote/relay-0.1.0+abc',
      "C:/Users/o'brien/.orca-remote/runtimes/node-x/node.exe",
      'feed'
    )
    expect(command).toMatch(/^powershell\.exe -NoProfile -NonInteractive -EncodedCommand \S+$/)
    expect(decodeRemotePowerShellScript(command)).toMatchInlineSnapshot(`
      "Set-Location -LiteralPath 'C:/Users/u/.orca-remote/relay-0.1.0+abc'
      $out = ''; $status = $null
      try { $out = ((& 'C:/Users/o''brien/.orca-remote/runtimes/node-x/node.exe' 'relay.js' '--orca-runtime-selftest' 'feed' 2>&1) | ForEach-Object { "$_" }) -join "\`n"; $status = $LASTEXITCODE } catch { $status = -1; $out = $_.Exception.Message }
      Write-Output ('ORCA_RUNTIME_EXIT=' + $status)
      Write-Output ($out.Substring(0, [Math]::Min(16000, $out.Length)))"
    `)
  })

  it('requires the report to name the pinned Node, since no separate --version runs', () => {
    expect(
      evaluateWindowsRelayRuntimeSelfTest(
        `ORCA_RUNTIME_EXIT=0\r\n${report('n', { ok: true })}`,
        'n'
      )
    ).toMatchObject({ verdict: 'passed' })
    expect(
      evaluateWindowsRelayRuntimeSelfTest(
        `ORCA_RUNTIME_EXIT=0\r\n${report('n', { ok: true, node: 'v22.16.0' })}`,
        'n'
      )
    ).toMatchObject({ verdict: 'failed' })
  })

  it('runs in a single unwrapped exec on a Windows host', async () => {
    vi.mocked(execCommand).mockReset()
    vi.mocked(execCommand).mockImplementationOnce(async (_conn, command) => {
      const nonce = /'--orca-runtime-selftest' '([0-9a-f]+)'/.exec(
        decodeRemotePowerShellScript(command)
      )?.[1]
      return `ORCA_RUNTIME_EXIT=0\r\n${report(nonce ?? '', { ok: true })}\r\n`
    })
    await expect(
      runPinnedRuntimeSelfTest(conn, 'C:/r', 'C:/n/node.exe', undefined, {
        host: getRemoteHostPlatform('win32-x64')
      })
    ).resolves.toMatchObject({ verdict: 'passed' })
    expect(execCommand).toHaveBeenCalledTimes(1)
    expect(vi.mocked(execCommand).mock.calls[0][2]).toMatchObject({ wrapCommand: false })
  })

  it('refuses a runtime whose ConPTY pair was quarantined after upload', () => {
    const output = `ORCA_RUNTIME_EXIT=0\r\n${report('n', {
      ok: false,
      stage: 'load',
      error: 'bundled ConPTY file missing after upload: C:/r/conpty/OpenConsole.exe'
    })}`
    expect(evaluateWindowsRelayRuntimeSelfTest(output, 'n')).toMatchObject({
      verdict: 'refused',
      refusal: 'security_software'
    })
  })
})

describe('runPinnedRuntimeSelfTest', () => {
  beforeEach(() => {
    vi.mocked(execCommand).mockReset()
  })

  const versionOk = `ORCA_RUNTIME_EXIT=0\nv${NODE_RUNTIME_PIN.version}`

  it('passes when both steps answer', async () => {
    vi.mocked(execCommand)
      .mockResolvedValueOnce(versionOk)
      .mockImplementationOnce(async (_conn, command) => {
        const nonce = /--orca-runtime-selftest '([0-9a-f]+)'/.exec(command)?.[1] ?? ''
        return `ORCA_RUNTIME_EXIT=0\n${report(nonce, { ok: true })}`
      })
    await expect(runPinnedRuntimeSelfTest(conn, '/r', '/n')).resolves.toMatchObject({
      verdict: 'passed'
    })
  })

  it('treats a timeout as unverifiable and retries once, never as a refusal', async () => {
    const timeout = Object.assign(new Error('timed out'), { code: SSH_EXEC_TIMEOUT_CODE })
    vi.mocked(execCommand).mockImplementation(async () => {
      throw timeout
    })
    const verdict = await runPinnedRuntimeSelfTest(conn, '/r', '/n')
    expect(verdict.verdict).toBe('unverifiable')
    expect(execCommand).toHaveBeenCalledTimes(2)
  })

  it('does not stack a retry on an unconfirmed teardown', async () => {
    const lost = Object.assign(new Error('channel lost'), { sshChannelCloseConfirmed: false })
    vi.mocked(execCommand).mockImplementation(async () => {
      throw lost
    })
    const verdict = await runPinnedRuntimeSelfTest(conn, '/r', '/n')
    expect(verdict.verdict).toBe('unverifiable')
    expect(verdict.verdict === 'unverifiable' && verdict.cause).toBe(lost)
    expect(execCommand).toHaveBeenCalledTimes(1)
  })

  it('does not retry an answered refusal', async () => {
    vi.mocked(execCommand).mockResolvedValue('ORCA_RUNTIME_EXIT=126\nPermission denied')
    await expect(runPinnedRuntimeSelfTest(conn, '/r', '/n')).resolves.toMatchObject({
      verdict: 'refused',
      refusal: 'noexec'
    })
    expect(execCommand).toHaveBeenCalledTimes(1)
  })

  it('bounds each step by the remaining 30 s budget', async () => {
    vi.mocked(execCommand).mockResolvedValue('ORCA_RUNTIME_EXIT=126\nPermission denied')
    await runPinnedRuntimeSelfTest(conn, '/r', '/n')
    const timeoutMs = vi.mocked(execCommand).mock.calls[0][2]?.timeoutMs ?? 0
    expect(timeoutMs).toBeGreaterThan(29_000)
    expect(timeoutMs).toBeLessThanOrEqual(30_000)
  })
})
