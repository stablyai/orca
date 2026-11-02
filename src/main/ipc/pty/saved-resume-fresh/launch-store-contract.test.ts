import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getPosixClaudeShellFunction } from '../../../../shared/claude-shell-function'
import { getPosixCodexShellLaunchPreflight } from '../../../../shared/codex-shell-function'
import { getPosixSavedRestoreScript } from '../../../../shared/saved-restore-scripts'
import {
  getSavedRestoreActionFiles,
  POSIX_SAVED_RESTORE_CAPTURE,
  POSIX_SAVED_RESTORE_INSTALL,
  SAVED_RESTORE_ACTION_ENV,
  SAVED_RESTORE_CHECK_ENV,
  SAVED_RESTORE_ORIGINAL_ENV,
  SAVED_RESTORE_ROOT_KEYS,
  SAVED_RESTORE_SCRIPT_ENV
} from '../../../../shared/saved-restore-dispatch'
import { encodeClaudeProjectPath } from '../../../ai-vault/claude-project-dir-encoding'
import { stripInheritedOrcaCodexHomeOverride } from '../host-env/codex-home'
import {
  CODEX_HEADER,
  CODEX_ID,
  CODEX_ROLLOUT,
  codexSessionsDay,
  writeStoreFile
} from './agent-store.test-fixture'
import { probeSavedResumeStore } from './store-presence'
import type { SavedRestoreRoots } from './store-query'

// The store a restore checks is the one its launched agent uses: each row runs the generated line
// under the real shell functions, in the order the bash wrapper runs them (user profile, then
// Orca's functions), with a stand-in CLI that records the roots the check reports from inside the
// invocation. The conversation is planted only where the agent actually ran, so the check must
// read found there, or unknown (resume) where no check ran; never missing.
const BASH = '/bin/bash'
const ID = '21f5e73a-4a3a-42ac-bd73-bc8d88256d65'
const ENTRY = '0123456789abcdef'
const TOKEN = '0123456789abcdef0123456789abcdef'

/** The root bash shell's order: capture, the user's profile, Orca's functions and installer, then
 *  the startup action its first prompt runs. Only a bare agent word is armed, as main arms it; a
 *  path runs as an ordinary command. */
function rootShell(root: string, command: string, profile = ''): string[] {
  const [agent = '', ...resumeArgs] = command.split(' ').map((word) => word.replace(/^'|'$/g, ''))
  const armed = agent === 'claude' || agent === 'codex'
  writeFileSync(join(root, 'restore.sh'), getPosixSavedRestoreScript())
  const files = getSavedRestoreActionFiles({
    entry: ENTRY,
    token: TOKEN,
    agent,
    resumeArgs,
    freshArgs: []
  })
  writeFileSync(join(root, 'action.sh'), files.sh)
  return [
    ...(armed
      ? [
          `${SAVED_RESTORE_ACTION_ENV}=${join(root, 'action')}`,
          `${SAVED_RESTORE_SCRIPT_ENV}=${join(root, 'restore')}`,
          `${SAVED_RESTORE_ORIGINAL_ENV}=${command}`
        ]
      : []),
    BASH,
    '--norc',
    '--noprofile',
    '-c',
    `${POSIX_SAVED_RESTORE_CAPTURE}\n${profile}\n${getPosixCodexShellLaunchPreflight()}${getPosixClaudeShellFunction()}${POSIX_SAVED_RESTORE_INSTALL}\n${armed ? '__orca_sr_prompt' : command}`
  ]
}
const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

/** A stand-in for the bundled CLI: records what the check reports and answers resume. */
function writeCheck(root: string): { path: string; reported: () => SavedRestoreRoots | null } {
  const path = join(root, 'orca-check')
  const out = join(root, 'reported')
  writeFileSync(
    path,
    `#!/bin/sh\n[ "$3" = --phase ] && exit 0\n{ ${SAVED_RESTORE_ROOT_KEYS.map((key) => `printf '%s=%s\\n' ${key} "\${${key}-}"`).join('; ')}; } > "${out}"\nexit 0\n`
  )
  chmodSync(path, 0o700)
  return {
    path,
    reported: () =>
      existsSync(out)
        ? Object.fromEntries(
            readFileSync(out, 'utf8')
              .split('\n')
              .map((line) => line.split(/=(.*)/s).slice(0, 2))
              .filter(([key, value]) => key && value)
          )
        : null
  }
}

function claudeFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-launch-store-')))
  roots.push(root)
  const a = join(root, 'account-a')
  const b = join(root, 'account-b')
  const bin = join(root, 'bin')
  const pointer = join(root, 'selected')
  const cwd = join(root, 'repo')
  for (const dir of [a, b, bin, cwd]) {
    mkdirSync(dir)
  }
  const fake = join(bin, 'claude')
  writeFileSync(fake, '#!/bin/sh\nprintf "%s" "${CLAUDE_CONFIG_DIR-}"\n')
  chmodSync(fake, 0o700)
  const gate = writeCheck(root)
  /** The folder the launched agent read, with the conversation planted only there. */
  const launch = (env: string[], command = `claude '--resume' '${ID}'`): string => {
    const result = spawnSync(
      '/usr/bin/env',
      [
        '-i',
        `HOME=${root}`,
        `PATH=${bin}:/usr/bin:/bin`,
        `ORCA_CLAUDE_PROFILE_POINTER=${pointer}`,
        `${SAVED_RESTORE_CHECK_ENV}=${gate.path}`,
        ...env,
        ...rootShell(root, command, '[ -f "$HOME/.bash_profile" ] && . "$HOME/.bash_profile"')
      ],
      { encoding: 'utf8', cwd }
    )
    expect(result.stderr).toBe('')
    // The pane shows the plain command first; the agent prints the folder it read last.
    const home = result.stdout.split('\n').at(-1) || join(root, '.claude')
    for (const store of [a, b, join(root, '.claude')]) {
      mkdirSync(join(store, 'projects', encodeClaudeProjectPath(cwd)), { recursive: true })
    }
    if (home.startsWith(root)) {
      mkdirSync(join(home, 'projects', encodeClaudeProjectPath(cwd)), { recursive: true })
      writeFileSync(join(home, 'projects', encodeClaudeProjectPath(cwd), `${ID}.jsonl`), '{}\n')
    }
    return home
  }
  /** What main reads for the check the launch just ran; no check at all resumes. */
  const check = async () => {
    const reported = gate.reported()
    return reported
      ? probeSavedResumeStore({
          agent: 'claude',
          providerSession: { key: 'session_id', id: ID },
          roots: reported,
          cwd,
          recipeArgs: '',
          settings: undefined
        })
      : 'unknown'
  }
  return { root, a, b, bin, pointer, launch, check }
}

const injected = (home: string) => [
  `CLAUDE_CONFIG_DIR=${home}`,
  `ORCA_CLAUDE_INJECTED_CONFIG_DIR=${home}`
]

describe.skipIf(process.platform === 'win32' || !existsSync(BASH))(
  'the Claude store a restore checks against the one its launch uses',
  () => {
    it('row 1: resolved injection A, pointer B, bare claude: launch reads B and so does the check', async () => {
      const f = claudeFixture()
      writeFileSync(f.pointer, f.b)
      expect(f.launch(injected(f.a))).toBe(f.b)
      await expect(f.check()).resolves.toBe('found')
    })

    it('row 2: a sourced startup file selecting B overrides injection A; the check reads B too', async () => {
      const f = claudeFixture()
      writeFileSync(f.pointer, f.a)
      writeFileSync(join(f.root, '.bash_profile'), '. "$HOME/.orca-extra"\n')
      writeFileSync(join(f.root, '.orca-extra'), `export CLAUDE_CONFIG_DIR=${f.b}\n`)
      expect(f.launch(injected(f.a))).toBe(f.b)
      await expect(f.check()).resolves.toBe('found')
    })

    it('row 3: an absolute binary bypasses the function, so nothing checks and the restore resumes', async () => {
      const f = claudeFixture()
      writeFileSync(f.pointer, f.a)
      expect(f.launch([], `${join(f.bin, 'claude')} '--resume' '${ID}'`)).toBe(
        join(f.root, '.claude')
      )
      await expect(f.check()).resolves.toBe('unknown')
    })

    it('precedence is unchanged by the check: a user override and the account pointer both win at launch', () => {
      const f = claudeFixture()
      writeFileSync(f.pointer, f.a)
      expect(f.launch(['CLAUDE_CONFIG_DIR=/user/own'])).toBe('/user/own')
      expect(f.launch(injected(f.b))).toBe(f.a)
      writeFileSync(f.pointer, '')
      expect(f.launch(injected(f.a))).toBe(join(f.root, '.claude'))
    })
  }
)

describe('the Codex store a non-daemon restore checks against the one its child gets', () => {
  it('F1: an inherited CODEX_HOME the provider strips for the child is not what the check reads', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-launch-store-codex-')))
    roots.push(root)
    const inherited = join(root, 'inherited-managed-home')
    mkdirSync(join(inherited, 'sessions'), { recursive: true })
    writeStoreFile(join(codexSessionsDay(join(root, '.codex')), CODEX_ROLLOUT), CODEX_HEADER)
    const childEnv: Record<string, string> = { CODEX_HOME: inherited, ORCA_CODEX_HOME: inherited }
    // The local provider's own step when no home is routed (local-configure.ts → buildPtyHostEnv).
    stripInheritedOrcaCodexHomeOverride(childEnv)
    expect(childEnv.CODEX_HOME).toBeUndefined()
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(bin, 'codex'), 0o700)
    const gate = writeCheck(root)
    const result = spawnSync(
      '/usr/bin/env',
      [
        '-i',
        `HOME=${root}`,
        `PATH=${bin}:/usr/bin:/bin`,
        `${SAVED_RESTORE_CHECK_ENV}=${gate.path}`,
        ...Object.entries(childEnv).map(([key, value]) => `${key}=${value}`),
        ...rootShell(root, `codex 'resume' '${CODEX_ID}'`)
      ],
      { encoding: 'utf8', cwd: root }
    )
    expect(result.stderr).toBe('')
    await expect(
      probeSavedResumeStore({
        agent: 'codex',
        providerSession: { key: 'session_id', id: CODEX_ID },
        roots: gate.reported() ?? {},
        cwd: root,
        recipeArgs: '',
        settings: { codexManagedAccounts: [] }
      })
    ).resolves.toBe('found')
  })
})
