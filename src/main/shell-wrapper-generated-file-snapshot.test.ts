// Read __fixtures__/shell-wrapper-snapshots/README.md before accepting snapshot changes.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureShellReadyWrappersAt } from './providers/local-pty-shell-ready-wrapper-generation'
import {
  getShellLaunchConfig as getDaemonShellLaunchConfig,
  getShellReadyWrapperRoot as getDaemonShellReadyWrapperRoot
} from './daemon/shell-ready'
import { getShellLaunchConfig as getLocalShellLaunchConfig } from './providers/local-pty-shell-ready'
import { selectShellStartupFeatures } from './shell-startup-features'

const STARTUP_COMMAND_FEATURES = selectShellStartupFeatures({
  shellPath: 'zsh',
  env: {},
  hasStartupCommand: true,
  waitsForShellReady: true,
  emitsStartupIdentity: true
})

// ZDOTDIR handback lets zsh read later startup files directly from the user's directory.
const WRAPPER_FILES = [
  ['zsh-zshenv', join('zsh', '.zshenv')],
  ['bash-rcfile', join('bash', 'rcfile')]
] as const

const SNAPSHOT_DIR = join(__dirname, '__fixtures__', 'shell-wrapper-snapshots')

// Bash still embeds a temporary wrapper root that varies per run.
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

// Non-Orca globals allowed by the shell or agent-overlay contracts.
const CONTRACT_GLOBALS = new Set([
  'BUFFER',
  'CODEX_HOME',
  // Exported only in the claude function's subshell.
  'CLAUDE_CONFIG_DIR',
  'HISTFILE',
  'MIMOCODE_HOME',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_AUTH_CONTENT',
  'OPENCODE_DB',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'PATH',
  'PROMPT_COMMAND',
  'PS1', // Bash appends its non-printing Readline readiness marker.
  'CURSOR',
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

// Wrapping is POSIX-only; native Windows paths would make these fixtures unstable.
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

  // User configs may constrain shell globals such as readonly REPLY; use Orca-owned scratch names.
  it.each([
    ['local', (): void => void ensureShellReadyWrappersAt(root), (): string => root],
    [
      'daemon',
      (): void => {
        process.env.ORCA_USER_DATA_PATH = root
        getDaemonShellLaunchConfig('/bin/zsh', STARTUP_COMMAND_FEATURES)
      },
      (): string => getDaemonShellReadyWrapperRoot()
    ]
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
