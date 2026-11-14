import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import {
  describePosix,
  restoreUserDataPathAfterEach,
  setTestUserDataPath
} from './local-pty-shell-ready-test-harness'
import { getBashShellReadyRcfileContent } from './local-pty-shell-ready-bash-rcfile'

restoreUserDataPathAfterEach()

const hasBash = process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0
const itWithBash = hasBash ? it : it.skip

function runInteractiveBashRcfile(
  rcfileContent: string,
  tempDir: string,
  input = 'true\nfalse\nexit 0\n'
): string {
  const rcfile = join(tempDir, 'bash-osc133-rcfile')
  writeFileSync(rcfile, rcfileContent)

  const result = spawnSync(
    'bash',
    ['-lc', 'bash --noprofile --rcfile "$1" -i 2>&1', 'bash', rcfile],
    {
      input,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: tempDir,
        ORCA_SHELL_FEATURES: 'ready',
        TERM: process.env.TERM || 'xterm'
      },
      timeout: 5000
    }
  )

  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  return result.stdout
}

function expectBashOsc133Lifecycle(output: string): void {
  const oscA = '\x1b]133;A\x07'
  const oscC = '\x1b]133;C\x07'
  const oscD = '\x1b]133;D;'
  const firstPromptMarker = output.indexOf(oscA)
  const lifecyclePattern = new RegExp(
    `${String.fromCharCode(27)}]133;(?:A|C|D;[0-9]+)${String.fromCharCode(7)}`,
    'g'
  )

  expect(firstPromptMarker).toBeGreaterThanOrEqual(0)
  expect(output.slice(0, firstPromptMarker)).not.toContain(oscC)
  expect(output.slice(0, firstPromptMarker)).not.toContain(oscD)
  expect(output.match(lifecyclePattern)).toEqual([
    oscA,
    oscC,
    `${oscD}0\x07`,
    oscA,
    oscC,
    `${oscD}1\x07`,
    oscA,
    oscC
  ])
}

describePosix('local PTY shell-ready launch config', () => {
  let userDataPath: string
  let previousOrcaOrigZdotdir: string | undefined

  beforeEach(() => {
    previousOrcaOrigZdotdir = process.env.ORCA_ORIG_ZDOTDIR
    delete process.env.ORCA_ORIG_ZDOTDIR
    userDataPath = mkdtempSync(join(tmpdir(), 'local-pty-shell-ready-test-'))
    setTestUserDataPath(userDataPath)
  })

  afterEach(() => {
    if (previousOrcaOrigZdotdir === undefined) {
      delete process.env.ORCA_ORIG_ZDOTDIR
    } else {
      process.env.ORCA_ORIG_ZDOTDIR = previousOrcaOrigZdotdir
    }
    rmSync(userDataPath, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  itWithBash('emits lifecycle for foreground text ending like an internal hook', () => {
    const input = 'echo user:__orca_osc133_prompt_done\nfalse\nexit 0\n'
    const output = runInteractiveBashRcfile(getBashShellReadyRcfileContent(), userDataPath, input)

    expect(output).toContain('user:__orca_osc133_prompt_done')
    expectBashOsc133Lifecycle(output)
  })

  itWithBash(
    'preserves prompt hooks and existing DEBUG traps without fake command markers',
    async () => {
      writeFileSync(
        join(userDataPath, '.bash_profile'),
        [
          'PROMPT_COMMAND=\'AFTER_FIRST_PROMPT=1; printf "PROMPT_HOOK\\n"\'',
          'trap \'if [[ -n "${AFTER_FIRST_PROMPT:-}" ]]; then\n  printf "USER_DEBUG_AFTER:<%s>\\n" "$BASH_COMMAND"\nfi\' DEBUG'
        ].join('\n')
      )

      const output = runInteractiveBashRcfile(getBashShellReadyRcfileContent(), userDataPath)

      expect(output).toContain('PROMPT_HOOK')
      expect(output).toContain('USER_DEBUG_AFTER')
      expect(output).toContain('USER_DEBUG_AFTER:<printf "PROMPT_HOOK\\n">')
      expect(output).not.toContain('USER_DEBUG_AFTER:<(( __orca_exit_code == 0 ))>')
      expect(output).not.toContain('USER_DEBUG_AFTER:<__orca_restore_prompt_status')
      expectBashOsc133Lifecycle(output)
    }
  )

  itWithBash('forwards a DEBUG trap replaced with local functrace', () => {
    writeFileSync(
      join(userDataPath, '.bash_profile'),
      [
        'set -T',
        'trap \'printf "OLD_DEBUG:<%s>\\n" "$BASH_COMMAND"\' DEBUG',
        'PROMPT_COMMAND=\'printf "PROMPT_HOOK\\n"\''
      ].join('\n')
    )
    const input = 'trap \'printf "NEW_DEBUG:<%s>\\n" "$BASH_COMMAND"\' DEBUG\nfalse\nexit 0\n'
    const output = runInteractiveBashRcfile(getBashShellReadyRcfileContent(), userDataPath, input)

    expect(output.split('OLD_DEBUG:<printf "PROMPT_HOOK\\n">')).toHaveLength(2)
    expect(output.split('NEW_DEBUG:<printf "PROMPT_HOOK\\n">')).toHaveLength(3)
    expectBashOsc133Lifecycle(output)
  })

  itWithBash('normalizes array PROMPT_COMMAND hooks so bash 3.2 still runs cleanup', async () => {
    writeFileSync(
      join(userDataPath, '.bash_profile'),
      'PROMPT_COMMAND=(\'printf "PROMPT_ARRAY_A\\n"\' \'printf "PROMPT_ARRAY_B\\n";  \')\n'
    )

    const output = runInteractiveBashRcfile(getBashShellReadyRcfileContent(), userDataPath)

    expect(output.split('PROMPT_ARRAY_A')).toHaveLength(4)
    expect(output.split('PROMPT_ARRAY_B')).toHaveLength(4)
    expectBashOsc133Lifecycle(output)
  })

  itWithBash('composes an inherited PROMPT_COMMAND ending in separators', () => {
    writeFileSync(
      join(userDataPath, '.bash_profile'),
      'PROMPT_COMMAND=\'printf "PROMPT_SEPARATOR\\n"; ;\t\n;;  \'\n'
    )

    const output = runInteractiveBashRcfile(getBashShellReadyRcfileContent(), userDataPath)

    expect(output).not.toContain('syntax error')
    expect(output).toContain('PROMPT_SEPARATOR')
    expectBashOsc133Lifecycle(output)
  })
})
