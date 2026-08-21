/**
 * Byte-for-byte snapshots of every shell wrapper file Orca generates, for all
 * three transports (local PTY, daemon/SSH, relay overlay).
 *
 * Why: the zsh generators were unified behind one builder; these fixtures were
 * captured from the pre-unification code so any drift shows up as a diff.
 *
 * Fixtures live in ./__fixtures__/shell-wrapper-snapshots/ — see the README there
 * before accepting a rewrite; a local run updates them silently.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureShellReadyWrappersAt } from './providers/local-pty-shell-ready-wrapper-generation'
import {
  getShellLaunchConfig as getDaemonShellLaunchConfig,
  getShellReadyWrapperRoot as getDaemonShellReadyWrapperRoot
} from './daemon/shell-ready'
import { ensureOverlayRestoreWrappers } from '../relay/pty-shell-overlay-wrappers'
import { getShellLaunchConfig as getLocalShellLaunchConfig } from './providers/local-pty-shell-ready'
import { selectShellStartupFeatures } from './shell-startup-features'

// Why the real selector: the snapshots then pin what a startup-command pane
// actually launches with, not a hand-written feature list.
const STARTUP_COMMAND_FEATURES = selectShellStartupFeatures({
  shellPath: 'zsh',
  env: {},
  hasStartupCommand: true,
  waitsForShellReady: true,
  emitsStartupIdentity: true
})

// Why one zsh file: the wrapper hands ZDOTDIR back on its first lines, so zsh
// reads .zprofile, .zshrc and .zlogin from the user's own directory.
const WRAPPER_FILES = [
  ['zsh-zshenv', join('zsh', '.zshenv')],
  ['bash-rcfile', join('bash', 'rcfile')]
] as const

const SNAPSHOT_DIR = join(__dirname, '__fixtures__', 'shell-wrapper-snapshots')

// Why still normalized: the zsh hook no longer bakes a wrapper path at all, but
// the bash rcfile can still carry one, and a temp root differs per run.
function withStableRoot(content: string, root: string): string {
  return content.split(root).join('<WRAPPER_ROOT>')
}

function snapshotPath(transport: string, label: string): string {
  return join(SNAPSHOT_DIR, `${transport}-${label}.txt`)
}

async function expectWrapperFiles(transport: string, root: string): Promise<void> {
  for (const [label, relativePath] of WRAPPER_FILES) {
    const content = readFileSync(join(root, relativePath), 'utf8')
    await expect(withStableRoot(content, root)).toMatchFileSnapshot(snapshotPath(transport, label))
  }
}

/**
 * Every shell name the wrapper is allowed to write that is not Orca-namespaced.
 *
 * Each is a deliberate contract with the shell or with Orca's own features, not
 * scratch space: the history path, the config dir, the two PATH-shaped exports
 * agent overlays need, and the prompt-hook arrays the readiness and OSC 133
 * markers register through.
 */
const CONTRACT_GLOBALS = new Set([
  'CODEX_HOME',
  'HISTFILE',
  'MIMOCODE_HOME',
  'OPENCODE_CONFIG_DIR',
  'PATH',
  'PROMPT_COMMAND',
  'ZDOTDIR',
  'precmd_functions',
  'preexec_functions'
])

// `local`/`local -a` declarations are function-scoped and cannot collide.
const LINE_START_ASSIGNMENT =
  /^[ \t]*(?:builtin[ \t]+)?(?:export[ \t]+|typeset[ \t]+-[a-zA-Z]+[ \t]+|declare[ \t]+-[a-zA-Z]+[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)\+?=/
const INLINE_EXPORT = /\bexport[ \t]+([A-Za-z_][A-Za-z0-9_]*)\+?=/g

function foreignGlobalsWritten(content: string): string[] {
  const names = new Set<string>()
  for (const line of content.split('\n')) {
    if (/^[ \t]*#/.test(line) || /^[ \t]*local\b/.test(line)) {
      continue
    }
    for (const name of [
      LINE_START_ASSIGNMENT.exec(line)?.[1],
      ...[...line.matchAll(INLINE_EXPORT)].map((match) => match[1])
    ]) {
      if (name && !/^_{0,2}orca_/i.test(name) && !CONTRACT_GLOBALS.has(name)) {
        names.add(name)
      }
    }
  }
  return [...names].sort()
}

// Why: all three generators are POSIX-only (the launch configs skip wrapping on
// win32), and native Windows path separators would make the fixtures unstable.
const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('generated shell wrapper files', () => {
  let root = ''
  let previousUserDataPath: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-wrapper-snapshot-'))
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  })

  afterEach(() => {
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('local PTY wrappers', async () => {
    ensureShellReadyWrappersAt(root)
    await expectWrapperFiles('local', root)
  })

  it('daemon wrappers', async () => {
    process.env.ORCA_USER_DATA_PATH = root
    getDaemonShellLaunchConfig('/bin/zsh', STARTUP_COMMAND_FEATURES)
    await expectWrapperFiles('daemon', getDaemonShellReadyWrapperRoot())
  })

  it('relay overlay wrappers', async () => {
    ensureOverlayRestoreWrappers(root)
    await expectWrapperFiles('relay', root)
  })

  // Why a rule and not another fixture: `REPLY`, zsh's shared scratch global,
  // was the wrapper's resolver out-parameter. A user config that constrained it
  // (`typeset -r REPLY`) aborted the wrapper at its first executable line — on
  // every zsh pane, once wrapping widened past overlay/startup panes. The
  // fixtures above would have shown that only to a reader who knew to look.
  it.each([
    ['local', (): void => void ensureShellReadyWrappersAt(root), (): string => root],
    [
      'daemon',
      (): void => {
        process.env.ORCA_USER_DATA_PATH = root
        getDaemonShellLaunchConfig('/bin/zsh', STARTUP_COMMAND_FEATURES)
      },
      (): string => getDaemonShellReadyWrapperRoot()
    ],
    ['relay', (): void => void ensureOverlayRestoreWrappers(root), (): string => root]
  ])('%s wrappers write no shell global outside Orca’s namespace', (_transport, generate, dir) => {
    generate()

    for (const [, relativePath] of WRAPPER_FILES) {
      const content = readFileSync(join(dir(), relativePath), 'utf8')
      expect({ [relativePath]: foreignGlobalsWritten(content) }).toEqual({ [relativePath]: [] })
    }
  })

  it('fish shell-ready init commands', async () => {
    process.env.ORCA_USER_DATA_PATH = root
    const local = getLocalShellLaunchConfig('/usr/bin/fish', STARTUP_COMMAND_FEATURES)
    const daemon = getDaemonShellLaunchConfig('/usr/bin/fish', STARTUP_COMMAND_FEATURES)
    await expect(local.args?.[2]).toMatchFileSnapshot(snapshotPath('local', 'fish-init'))
    await expect(daemon.args?.[2]).toMatchFileSnapshot(snapshotPath('daemon', 'fish-init'))
  })
})
