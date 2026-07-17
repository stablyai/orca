import { describe, expect, it } from 'vitest'

import {
  assertSshRelayRuntimeToolchain,
  collectSshRelayRuntimeToolchain,
  selectSshRelayRuntimeToolVersion,
  selectSshRelayRuntimeWindowsMsvcLinker,
  sshRelayRuntimeBuilderIdentity,
  sshRelayRuntimeRunnerIdentity,
  sshRelayRuntimePythonCommand,
  sshRelayRuntimeStripVersionProbe,
  sshRelayRuntimeWindowsMsvcToolsetVersion
} from './ssh-relay-runtime-toolchain.mjs'

const commit = 'a'.repeat(40)

describe('SSH relay runtime build provenance', () => {
  it('selects the real Windows compiler version instead of its stdout usage line', () => {
    expect(
      selectSshRelayRuntimeToolVersion(
        {
          stdout: 'usage: cl [ option... ] filename... [ /link linkoption... ]',
          stderr: [
            'Microsoft (R) C/C++ Optimizing Compiler Version 19.44.35228 for ARM64',
            'Copyright (C) Microsoft Corporation.'
          ].join('\r\n')
        },
        /Compiler Version/i
      )
    ).toBe('Microsoft (R) C/C++ Optimizing Compiler Version 19.44.35228 for ARM64')
  })

  it('selects a bounded Windows linker toolset version', () => {
    expect(
      selectSshRelayRuntimeToolVersion({ stdout: 'MSVC 14.44.35207\r\n' }, /^MSVC \d+\.\d+\.\d+$/)
    ).toBe('MSVC 14.44.35207')
  })

  it('derives the version only from a canonical resolved MSVC linker path', () => {
    const path = String.raw`C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Tools\MSVC\14.44.35207\bin\HostX64\x64\link.exe`
    expect(sshRelayRuntimeWindowsMsvcToolsetVersion(path)).toBe('MSVC 14.44.35207')
    expect(
      sshRelayRuntimeWindowsMsvcToolsetVersion(
        String.raw`C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Tools\MSVC\14.44.35207\bin\HostARM64\ARM64\link.exe`
      )
    ).toBe('MSVC 14.44.35207')
    expect(() =>
      sshRelayRuntimeWindowsMsvcToolsetVersion(String.raw`C:\tools\14.44.35207\link.exe`)
    ).toThrow(/MSVC toolset path/)
    expect(() =>
      sshRelayRuntimeWindowsMsvcToolsetVersion(
        String.raw`C:\MSVC\14.44.35207\bin\shadow\MSVC\14.44.1\bin\link.exe`
      )
    ).toThrow(/MSVC toolset path/)
  })

  it('selects exactly one canonical MSVC linker after Git for Windows PATH entries', () => {
    const x64 = String.raw`C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Tools\MSVC\14.44.35207\bin\HostX64\x64\link.exe`
    const arm64 = String.raw`C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Tools\MSVC\14.44.35207\bin\HostARM64\ARM64\link.exe`
    const git = String.raw`C:\Program Files\Git\usr\bin\link.exe`
    expect(selectSshRelayRuntimeWindowsMsvcLinker([git, x64])).toBe(x64)
    expect(selectSshRelayRuntimeWindowsMsvcLinker([git, arm64])).toBe(arm64)
    expect(() => selectSshRelayRuntimeWindowsMsvcLinker([git])).toThrow(
      /exactly one canonical MSVC linker/
    )
    expect(() => selectSshRelayRuntimeWindowsMsvcLinker([x64, arm64])).toThrow(
      /exactly one canonical MSVC linker/
    )
  })

  it('bounds failed version diagnostics', () => {
    expect(() =>
      selectSshRelayRuntimeToolVersion({ stderr: `unexpected ${'x'.repeat(1_000)}` }, /version/i)
    ).toThrow(/^Runtime build tool did not report a bounded version line: unexpected x{490}/)
  })

  it('bounds rejected Windows linker path diagnostics', () => {
    const path = `C:\\${'unexpected\\'.repeat(100)}link.exe`
    expect(() => sshRelayRuntimeWindowsMsvcToolsetVersion(path)).toThrow(
      /^Resolved Windows linker is not in a bounded MSVC toolset path: .{1,512}$/
    )
    expect(() =>
      selectSshRelayRuntimeWindowsMsvcLinker(
        Array.from({ length: 20 }, (_, index) => `C:\\${index}\\${'x'.repeat(600)}\\link.exe`)
      )
    ).toThrow(/^Runtime build did not resolve exactly one canonical MSVC linker: .{1,512}$/)
  })

  it('pins GitHub builder identity to the exact source commit', () => {
    expect(
      sshRelayRuntimeBuilderIdentity({
        gitCommit: commit,
        env: {
          GITHUB_ACTIONS: 'true',
          GITHUB_REPOSITORY: 'stablyai/orca',
          GITHUB_WORKFLOW_REF:
            'stablyai/orca/.github/workflows/ssh-relay-runtime-artifacts.yml@refs/pull/8741/merge'
        }
      })
    ).toBe(
      `https://github.com/stablyai/orca/blob/${commit}/.github/workflows/ssh-relay-runtime-artifacts.yml`
    )
    expect(() =>
      sshRelayRuntimeBuilderIdentity({
        gitCommit: commit,
        env: {
          GITHUB_ACTIONS: 'true',
          GITHUB_REPOSITORY: 'stablyai/orca',
          GITHUB_WORKFLOW_REF: 'other/repo/.github/workflows/untrusted.yml@refs/heads/main'
        }
      })
    ).toThrow(/workflow identity/i)
  })

  it('requires the resolved runner label, architecture, environment, and image identity', () => {
    expect(
      sshRelayRuntimeRunnerIdentity({
        env: {
          GITHUB_ACTIONS: 'true',
          RUNNER_OS: 'Windows',
          RUNNER_ARCH: 'ARM64',
          RUNNER_ENVIRONMENT: 'github-hosted',
          ORCA_RUNTIME_REQUESTED_RUNNER: 'windows-11-arm',
          ImageOS: 'win11-arm64',
          ImageVersion: '20260706.102.1'
        }
      })
    ).toEqual({
      os: 'Windows',
      architecture: 'ARM64',
      environment: 'github-hosted',
      requestedLabel: 'windows-11-arm',
      image: { os: 'win11-arm64', version: '20260706.102.1' }
    })
    expect(() =>
      sshRelayRuntimeRunnerIdentity({
        env: {
          GITHUB_ACTIONS: 'true',
          RUNNER_OS: 'Windows',
          RUNNER_ARCH: 'ARM64'
        }
      })
    ).toThrow(/runner identity/i)
  })

  it('requests an actual GNU strip version and pins Apple strip to Xcode', () => {
    expect(sshRelayRuntimeStripVersionProbe('linux')).toEqual({ args: ['--version'] })
    expect(sshRelayRuntimeStripVersionProbe('darwin')).toEqual({
      versionCommand: 'xcodebuild',
      versionArgs: ['-version']
    })
  })

  it('records the exact Python forced into Linux node-gyp', () => {
    expect(
      sshRelayRuntimePythonCommand('linux', {
        NODE_GYP_FORCE_PYTHON: '/usr/bin/python3.9'
      })
    ).toBe('/usr/bin/python3.9')
    expect(sshRelayRuntimePythonCommand('darwin', {})).toBe('python3')
    expect(sshRelayRuntimePythonCommand('win32', {})).toBe('python.exe')
  })

  it('records bounded native tool versions and SHA-256 executable or code digests', async () => {
    const toolchain = await collectSshRelayRuntimeToolchain(process.execPath)
    const tuple = process.platform === 'win32' ? 'win32-x64' : 'linux-x64-glibc'
    expect(() => assertSshRelayRuntimeToolchain(toolchain, tuple)).not.toThrow()
    expect(toolchain).toMatchObject({
      bundledNode: { version: process.version },
      buildNode: { version: process.version },
      nodeGyp: { version: expect.any(String) },
      nodeAddonApi: { version: expect.any(String) },
      compiler: { version: expect.any(String) },
      buildSystem: { version: expect.any(String) },
      python: { version: expect.any(String) },
      archive: { version: expect.any(String) }
    })
    for (const record of Object.values(toolchain)) {
      expect(record.sha256).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(Buffer.byteLength(record.version)).toBeGreaterThan(0)
      expect(Buffer.byteLength(record.version)).toBeLessThanOrEqual(512)
    }
    expect(() =>
      assertSshRelayRuntimeToolchain(
        { ...toolchain, compiler: { version: toolchain.compiler.version } },
        tuple
      )
    ).toThrow(/compiler/i)
  })
})
