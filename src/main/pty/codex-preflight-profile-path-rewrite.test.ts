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

// Why (STA-4270): the generated rcfile sources /etc/profile and the user's profile
// *before* it defines the codex() wrapper, so a profile PATH prepend decides what an
// unqualified preflight command resolves to. This drives the real generated rcfile
// through a real bash and uses filesystem markers — not scraped output — as the oracle.

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

  // The CLI Orca ships, at the absolute path Orca controls.
  writeStub(getBundledLauncherPath(process.platform, resourcesPath) as string, intendedMarker)
  // The impostor a user's own bin directory could hold under every CLI name Orca uses.
  for (const name of ['orca', 'orca-ide', 'orca-dev']) {
    writeStub(join(hijackDir, name), hijackMarker)
  }
  writeStub(join(codexDir, 'codex'), codexMarker)

  // Why: /etc/profile runs first and macOS path_helper rebuilds PATH from /etc/paths,
  // so the profile must re-prepend both dirs to model a real user's dotfile winning.
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
  // Why the second command: the rcfile defines __orca_osc133_preexec *below* the
  // codex wrapper, so its presence proves bash parsed past the snippet.
  // Why the trailing `:` — the markers are this file's oracle, so a failed probe
  // must surface as a missing marker, not an opaque non-zero exit from bash.
  const command = `codex --version; declare -F __orca_osc133_preexec >/dev/null && printf ran > ${JSON.stringify(fixture.postSnippetMarker)}; :`
  execFileSync('/bin/bash', ['--rcfile', rcfilePath, '-i', '-c', command], {
    stdio: 'ignore',
    env: {
      HOME: fixture.homePath,
      // Why: the hijack dir is deliberately absent here — only the profile adds it.
      PATH: ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
      TERM: 'dumb',
      SHELL: '/bin/bash',
      // Why no ORCA_SHELL_FEATURES: absent means no features, so the rcfile
      // emits neither the identity nor the readiness marker into stdout.
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
  it('sources the user profile before emitting the codex wrapper', () => {
    const rcfile = getDaemonBashShellReadyRcfileContent()

    expect(rcfile.indexOf('source "$HOME/.bash_profile"')).toBeLessThan(
      rcfile.indexOf('ORCA_CODEX_LAUNCH_PREFLIGHT')
    )
  })

  it('runs the bundled CLI the resolver picked, not the impostor the profile put first', () => {
    const fixture = buildFixture()
    const preflightCommand = resolveCodexShellLaunchPreflightCommand({
      hooksEnabled: true,
      isPackaged: true,
      managedHomePath: join(fixture.root, 'codex-home'),
      userDataPath: join(fixture.root, 'user-data'),
      resourcesPath: fixture.resourcesPath
    })
    expect(preflightCommand).toBe(getBundledLauncherPath(process.platform, fixture.resourcesPath))

    launchCodexThroughRcfile(fixture, preflightCommand as string)

    expect(existsSync(fixture.intendedMarker)).toBe(true)
    expect(existsSync(fixture.hijackMarker)).toBe(false)
    // Guard against a vacuous pass: the wrapper must still have reached `command codex`.
    expect(existsSync(fixture.codexMarker)).toBe(true)
  })

  // Why: a user alias named codex used to expand into the wrapper's own `codex()`
  // header, and bash abandons the rest of the rcfile at that syntax error — taking
  // the OSC 133 hooks and the shell-ready marker defined below it with it.
  it('finishes the rcfile and preserves the alias when the user aliased the name codex', () => {
    const fixture = buildFixture({ aliasCodex: true })
    const preflightCommand = resolveCodexShellLaunchPreflightCommand({
      hooksEnabled: true,
      isPackaged: true,
      managedHomePath: join(fixture.root, 'codex-home'),
      userDataPath: join(fixture.root, 'user-data'),
      resourcesPath: fixture.resourcesPath
    })

    launchCodexThroughRcfile(fixture, preflightCommand as string)

    expect(existsSync(fixture.postSnippetMarker)).toBe(true)
    expect(existsSync(fixture.intendedMarker)).toBe(true)
    expect(existsSync(fixture.hijackMarker)).toBe(false)
    // The user's own alias must survive and still reach the binary.
    expect(readFileSync(fixture.codexMarker, 'utf-8').trim()).toBe('--alias-flag --version')
  })

  // Why: pins the defect itself, so a regression back to an unqualified name fails here.
  it('would run the impostor if the preflight carried an unqualified command name', () => {
    const fixture = buildFixture()

    launchCodexThroughRcfile(fixture, 'orca')

    expect(existsSync(fixture.hijackMarker)).toBe(true)
    expect(existsSync(fixture.intendedMarker)).toBe(false)
    expect(existsSync(fixture.codexMarker)).toBe(true)
  })
})
