import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getPosixClaudeShellFunction } from '../../../../shared/claude-shell-function'
import { encodeClaudeProjectPath } from '../../../ai-vault/claude-project-dir-encoding'
import { stripInheritedOrcaCodexHomeOverride } from '../host-env/codex-home'
import { claudeStorePresence } from './claude-store-presence'
import { probeSavedResumeStore } from './store-presence'
import type { SavedResumeStoreQuery } from './store-query'
import { newStoreReadBudget } from './store-walk'

// Experiment for R1-PANEL-3: does the store the check reads equal the store the launched agent
// uses? Each row runs a fake `claude` under the real generated shell function, in the order the
// bash wrapper runs it (user profile, then Orca's function), and plants the conversation only in
// the folder the agent actually used. found = the check read that folder; unknown = safe;
// missing = the check read another store, so a restore would start fresh wrongly.
const BASH = '/bin/bash'
const ID = '21f5e73a-4a3a-42ac-bd73-bc8d88256d65'
const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

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
  /** The folder the launched agent read, with the conversation planted only there. */
  const launch = (env: string[], command = 'claude'): string => {
    const result = spawnSync(
      '/usr/bin/env',
      [
        '-i',
        `HOME=${root}`,
        `PATH=${bin}:/usr/bin:/bin`,
        `ORCA_CLAUDE_PROFILE_POINTER=${pointer}`,
        ...env,
        BASH,
        '--norc',
        '--noprofile',
        '-c',
        `[ -f "$HOME/.bash_profile" ] && . "$HOME/.bash_profile"\n${getPosixClaudeShellFunction()}\n${command}`
      ],
      { encoding: 'utf8', cwd: root }
    )
    expect(result.stderr).toBe('')
    const home = result.stdout || join(root, '.claude')
    for (const store of [a, b, join(root, '.claude')]) {
      mkdirSync(join(store, 'projects', encodeClaudeProjectPath(cwd)), { recursive: true })
    }
    if (home.startsWith(root)) {
      mkdirSync(join(home, 'projects', encodeClaudeProjectPath(cwd)), { recursive: true })
      writeFileSync(join(home, 'projects', encodeClaudeProjectPath(cwd), `${ID}.jsonl`), '{}\n')
    }
    return home
  }
  const check = (env: string[]) =>
    claudeStorePresence(
      {
        agent: 'claude',
        providerSession: { key: 'session_id', id: ID },
        launchEnv: {
          HOME: root,
          SHELL: BASH,
          ORCA_CLAUDE_PROFILE_POINTER: pointer,
          ...Object.fromEntries(env.map((entry) => entry.split(/=(.*)/s).slice(0, 2)))
        },
        cwd,
        codexHome: { selected: null, verified: false },
        recipeArgs: '',
        settings: undefined
      },
      newStoreReadBudget()
    )
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
      await expect(f.check(injected(f.a))).resolves.toBe('found')
    })

    it('row 2: a sourced startup file selecting B overrides injection A; the check reads A', async () => {
      const f = claudeFixture()
      writeFileSync(f.pointer, f.a)
      writeFileSync(join(f.root, '.bash_profile'), '. "$HOME/.orca-extra"\n')
      writeFileSync(join(f.root, '.orca-extra'), `export CLAUDE_CONFIG_DIR=${f.b}\n`)
      expect(f.launch(injected(f.a))).toBe(f.b)
      // Violation: the static startup scan cannot see a sourced file, so the check follows A.
      await expect(f.check(injected(f.a))).resolves.toBe('missing')
    })

    it('row 3: pointer A, no injection, absolute binary: launch reads the default; the check reads A', async () => {
      const f = claudeFixture()
      writeFileSync(f.pointer, f.a)
      expect(f.launch([], join(f.bin, 'claude'))).toBe(join(f.root, '.claude'))
      // Violation: only the word `claude` runs Orca's function; a path bypasses the pointer.
      await expect(f.check([])).resolves.toBe('missing')
    })

    it('row 4: an invocation prefix pins the check folder only by overriding the user and account choices', () => {
      const f = claudeFixture()
      // The existing invocation pin is the CODEX_HOME=<home> prefix (ai-vault-resume-command.ts).
      // Its Claude analogue, set to the folder the check read for each of rows 1-3's inputs:
      const pin = (home: string, command = 'claude') => `CLAUDE_CONFIG_DIR='${home}' ${command}`
      // Row 1 inputs (check read B): pinning B keeps B, which the pointer already chose.
      writeFileSync(f.pointer, f.b)
      expect(f.launch(injected(f.a), pin(f.b))).toBe(f.b)
      // Row 2 inputs (check read A): the pin replaces the user's own startup-file choice B with A.
      writeFileSync(f.pointer, f.a)
      writeFileSync(join(f.root, '.bash_profile'), `export CLAUDE_CONFIG_DIR=${f.b}\n`)
      expect(f.launch(injected(f.a))).toBe(f.b)
      expect(f.launch(injected(f.a), pin(f.a))).toBe(f.a)
      rmSync(join(f.root, '.bash_profile'))
      // Row 3 inputs (check read A): the absolute binary reads the default today; the pin forces A.
      expect(f.launch([], join(f.bin, 'claude'))).toBe(join(f.root, '.claude'))
      expect(f.launch([], pin(f.a, join(f.bin, 'claude')))).toBe(f.a)
      // A pin equal to the injected twin pins nothing: the function rereads the pointer at launch.
      writeFileSync(f.pointer, f.b)
      expect(f.launch(injected(f.a), pin(f.a))).toBe(f.b)
    })

    it("today's behavior, kept separately: a user override and the account pointer both win at launch", () => {
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
  it('F1: an inherited CODEX_HOME=ORCA_CODEX_HOME is stripped for the child but read by the check', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-launch-store-codex-')))
    roots.push(root)
    const inherited = join(root, 'inherited-managed-home')
    mkdirSync(join(inherited, 'sessions'), { recursive: true })
    const childEnv: Record<string, string> = { CODEX_HOME: inherited, ORCA_CODEX_HOME: inherited }
    // The local provider's own step when no home is routed (local-configure.ts → buildPtyHostEnv).
    stripInheritedOrcaCodexHomeOverride(childEnv)
    expect(childEnv.CODEX_HOME).toBeUndefined()
    const query: SavedResumeStoreQuery = {
      agent: 'codex',
      providerSession: { key: 'session_id', id: '019f1abc-0000-7000-8000-00000000aaaa' },
      launchEnv: { HOME: root, SHELL: BASH, CODEX_HOME: inherited, ORCA_CODEX_HOME: inherited },
      cwd: root,
      codexHome: { selected: null, verified: false },
      recipeArgs: '',
      settings: { codexManagedAccounts: [] }
    }
    // Violation: the child reads ~/.codex, but the check read the stripped home and found it empty.
    await expect(probeSavedResumeStore(query)).resolves.toBe('missing')
  })
})
