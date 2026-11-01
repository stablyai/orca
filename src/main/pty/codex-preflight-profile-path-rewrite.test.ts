import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getBundledLauncherPath } from '../cli/bundled-cli-launcher-path'
import { getDaemonBashShellReadyRcfileContent } from '../daemon/daemon-bash-shell-ready-rcfile'
import { resolveCodexShellLaunchPreflightCommand } from './codex-shell-launch-preflight'

// STA-4270: real rcfile execution and file markers prove profile PATH changes cannot hijack preflight.

const roots: string[] = []
const bashAvailable = process.platform !== 'win32' && existsSync('/bin/bash')

type Fixture = {
  root: string
  resourcesPath: string
  intendedMarker: string
  hijackMarker: string
  codexMarker: string
  postSnippetMarker: string
  homePath: string
}

function writeStub(path: string, markerPath: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(markerPath)}\n`)
  chmodSync(path, 0o755)
}

function buildFixture(options: { aliasCodex?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-profile-path-'))
  roots.push(root)
  const resourcesPath = join(root, 'resources')
  const hijackDir = join(root, 'hijack')
  const codexDir = join(root, 'codex-bin')
  const homePath = join(root, 'home')
  const intendedMarker = join(root, 'intended-ran')
  const hijackMarker = join(root, 'hijack-ran')
  const codexMarker = join(root, 'codex-ran')
  const postSnippetMarker = join(root, 'rcfile-continued')
  mkdirSync(hijackDir, { recursive: true })
  mkdirSync(codexDir, { recursive: true })
  mkdirSync(homePath, { recursive: true })

  const launcherPath = getBundledLauncherPath('win32', resourcesPath)
  if (!launcherPath) {
    throw new Error('Windows has a bundled launcher path')
  }
  writeStub(launcherPath, intendedMarker)
  // Model hostile binaries under every Orca CLI spelling.
  for (const name of ['orca', 'orca-ide', 'orca-dev']) {
    writeStub(join(hijackDir, name), hijackMarker)
  }
  writeStub(join(codexDir, 'codex'), codexMarker)

  // /etc/profile and macOS path_helper run first; the user profile must re-prepend fixture paths.
  const aliasLine = options.aliasCodex
    ? `alias codex='GIT_AUTHOR_NAME=Codex codex --alias-flag'\n`
    : ''
  writeFileSync(
    join(homePath, '.bash_profile'),
    `export PATH=${JSON.stringify(codexDir)}:"$PATH"\nexport PATH=${JSON.stringify(hijackDir)}:"$PATH"\n${aliasLine}`
  )
  return {
    root,
    resourcesPath,
    intendedMarker,
    hijackMarker,
    codexMarker,
    postSnippetMarker,
    homePath
  }
}

function launchCodexThroughRcfile(fixture: Fixture, preflightValue: string): void {
  const rcfilePath = join(fixture.root, 'rcfile')
  writeFileSync(rcfilePath, getDaemonBashShellReadyRcfileContent(), 'utf8')
  // The later OSC hook proves parsing passed the wrapper; trailing : leaves marker absence as the failure.
  const command = `codex --version; declare -F __orca_osc133_preexec >/dev/null && printf ran > ${JSON.stringify(fixture.postSnippetMarker)}; :`
  execFileSync('/bin/bash', ['--rcfile', rcfilePath, '-i', '-c', command], {
    stdio: 'ignore',
    env: {
      HOME: fixture.homePath,
      // Only the user profile introduces the hostile PATH entry.
      PATH: ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
      TERM: 'dumb',
      SHELL: '/bin/bash',
      // No features means no identity/readiness markers in captured stdout.
      ORCA_CODEX_HOME: join(fixture.root, 'codex-home'),
      ORCA_CODEX_LAUNCH_PREFLIGHT: preflightValue
    }
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe.skipIf(!bashAvailable)('Codex preflight under a profile-rewritten PATH', () => {
  it('runs the bundled CLI the resolver picked, not the impostor the profile put first', () => {
    const fixture = buildFixture()
    const preflightCommand = resolveCodexShellLaunchPreflightCommand({
      hooksEnabled: true,
      isPackaged: true,
      isWsl: true,
      managedHomePath: join(fixture.root, 'codex-home'),
      resourcesPath: fixture.resourcesPath,
      platform: 'win32'
    })
    expect(preflightCommand).toBe(getBundledLauncherPath('win32', fixture.resourcesPath))

    launchCodexThroughRcfile(fixture, preflightCommand as string)

    expect(existsSync(fixture.intendedMarker)).toBe(true)
    expect(existsSync(fixture.hijackMarker)).toBe(false)
    // Prove the wrapper reached the real Codex binary.
    expect(existsSync(fixture.codexMarker)).toBe(true)
  })

  // A codex alias can expand into the function header and prevent all later rcfile hooks from parsing.
  it('finishes the rcfile and preserves the alias when the user aliased the name codex', () => {
    const fixture = buildFixture({ aliasCodex: true })
    const preflightCommand = resolveCodexShellLaunchPreflightCommand({
      hooksEnabled: true,
      isPackaged: true,
      isWsl: true,
      managedHomePath: join(fixture.root, 'codex-home'),
      resourcesPath: fixture.resourcesPath,
      platform: 'win32'
    })

    launchCodexThroughRcfile(fixture, preflightCommand as string)

    expect(existsSync(fixture.postSnippetMarker)).toBe(true)
    expect(existsSync(fixture.intendedMarker)).toBe(true)
    expect(existsSync(fixture.hijackMarker)).toBe(false)
    expect(readFileSync(fixture.codexMarker, 'utf-8').trim()).toBe('--alias-flag --version')
  })

  it('skips an unqualified preflight value while still launching codex', () => {
    const fixture = buildFixture()

    launchCodexThroughRcfile(fixture, 'orca')

    expect(existsSync(fixture.hijackMarker)).toBe(false)
    expect(existsSync(fixture.intendedMarker)).toBe(false)
    expect(existsSync(fixture.codexMarker)).toBe(true)
  })
})
