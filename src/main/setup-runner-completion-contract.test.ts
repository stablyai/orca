import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile, realpath, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { expect, it } from 'vitest'
import { makeHookTestRepo } from './hooks-test-fixtures'
import { buildSetupRunnerCommand } from '../shared/setup-runner-command'
import { buildPosixRunnerScript } from './setup-runner-script-text'
import { createSetupRunnerScript } from './worktree-runner-script'
import { createSequencedSetupAgentCommands } from '../shared/setup-agent-sequencing'
import {
  appendNativeSetupCompletion,
  createSetupCompletionScanner,
  stripNativeSetupCompletionEnvironment
} from './runtime/orchestration/setup-completion-signal'

it.skipIf(process.platform === 'win32')(
  'observes caller-wrapped setup without replacing user exit traps or exiting the parent shell',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-31255-setup-'))
    try {
      const checkout = join(root, 'checkout')
      const initialized = await runProcess({
        program: '/usr/bin/git',
        args: ['init', '-q', '--separate-git-dir', join(root, 'metadata'), checkout]
      })
      expect(initialized.code, initialized.stderr).toBe(0)
      const setup = createSetupRunnerScript(
        makeHookTestRepo(),
        checkout,
        'trap \'printf "user-trap\\n"\' EXIT\nexit 17'
      )
      const wrapped = createSequencedSetupAgentCommands({
        runnerScriptPath: setup.runnerScriptPath,
        startupCommand: 'unused',
        platform: 'posix'
      })
      const result = await runProcess({
        program: '/bin/bash',
        args: [
          '-c',
          `${appendNativeSetupCompletion(wrapped.setupCommand, setup.envVars.ORCA_SETUP_COMPLETION_TOKEN, 'posix')}; printf 'parent-alive\\n'`
        ],
        cwd: checkout,
        env: { ...process.env, ...setup.envVars, HOME: root },
        timeoutMs: 10_000
      })
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toContain('user-trap')
      expect(result.stdout).toContain('parent-alive')
      let status: number | undefined
      createSetupCompletionScanner(setup.envVars.ORCA_SETUP_COMPLETION_TOKEN, (value) => {
        status = value
      }).scan(result.stdout)
      expect(status).toBe(17)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'preserves retained plain setup cwd, environment, options and exit behavior under a login profile',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-31255-plain-setup-'))
    try {
      const checkout = join(root, 'checkout')
      const initialized = await runProcess({
        program: '/usr/bin/git',
        args: ['init', '-q', '--separate-git-dir', join(root, 'metadata'), checkout]
      })
      expect(initialized.code, initialized.stderr).toBe(0)
      await writeFile(join(root, '.bash_profile'), 'cd "$HOME"\nexport SETUP_PROFILE_VALUE=login\n')
      const env = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_DATA_HOME: join(root, 'data'),
        XDG_CACHE_HOME: join(root, 'cache'),
        CLAUDE_CONFIG_DIR: join(root, 'claude'),
        CODEX_HOME: join(root, 'codex'),
        ORCA_E2E_USER_DATA_DIR: join(root, 'orca'),
        ORCA_E2E_HOME_DIR: root,
        ORCA_DISABLE_MACOS_LOGIN_SHELL: '1',
        PATH: '/bin:/usr/bin',
        BASH_ENV: '',
        ENV: '',
        SETUP_PROFILE_VALUE: 'terminal'
      }
      const login = await runProcess({
        program: '/bin/bash',
        args: ['-lc', 'printf "%s:%s" "$PWD" "$SETUP_PROFILE_VALUE"'],
        cwd: checkout,
        env
      })
      expect(login.stdout).toBe(`${root}:login`)
      for (const ending of ['printf "ordinary\\n"', 'exit 17', 'false\nprintf "unreachable\\n"']) {
        const script = `#!/bin/bash -e\nprintf 'body:%s:%s\\n' "$PWD" "$SETUP_PROFILE_VALUE"\ntrap 'printf "user-trap\\n"' EXIT\n${ending}`
        const basePath = join(root, 'base.sh')
        await writeFile(basePath, buildPosixRunnerScript(script))
        const setup = createSetupRunnerScript(makeHookTestRepo(), checkout, script)
        expect(await readFile(setup.runnerScriptPath, 'utf8')).toBe(buildPosixRunnerScript(script))
        const run = (runner: string) =>
          runProcess({
            program: '/bin/bash',
            args: [
              '--noprofile',
              '--norc',
              '-c',
              `${buildSetupRunnerCommand(runner, 'posix')}; status=$?; printf 'launch-status:%s\\nparent-alive\\n' "$status"`
            ],
            cwd: checkout,
            env: { ...env, ...setup.envVars },
            timeoutMs: 10_000
          })
        const base = await run(basePath)
        const native = appendNativeSetupCompletion(
          buildSetupRunnerCommand(setup.runnerScriptPath, 'posix'),
          setup.envVars.ORCA_SETUP_COMPLETION_TOKEN,
          'posix'
        )
        const nativeEnv = { ...env, ...setup.envVars }
        stripNativeSetupCompletionEnvironment(nativeEnv)
        expect(nativeEnv['ORCA_SETUP_COMPLETION_TOKEN']).toBeUndefined()
        const observed = await runProcess({
          program: '/bin/bash',
          args: [
            '--noprofile',
            '--norc',
            '-c',
            `${native}; status=$?; printf 'launch-status:%s\\nparent-alive\\n' "$status"`
          ],
          cwd: checkout,
          env: nativeEnv,
          timeoutMs: 10_000
        })
        expect(base.code, base.stderr).toBe(0)
        expect(observed.code, observed.stderr).toBe(0)
        expect(base.stdout).toContain(`body:${await realpath(checkout)}:terminal`)
        let status: number | undefined
        createSetupCompletionScanner(setup.envVars.ORCA_SETUP_COMPLETION_TOKEN, (value) => {
          status = value
        }).scan(observed.stdout)
        expect(status).toBe(ending.startsWith('printf') ? 0 : ending === 'exit 17' ? 17 : 1)
        const withoutMarker = observed.stdout.replace(/\nORCA_SETUP_DONE:[^\n]+;\n/, '')
        expect(withoutMarker).toBe(base.stdout)
        expect(observed.stdout).toContain('parent-alive')
        expect(observed.stdout.match(/user-trap/g)).toHaveLength(1)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'native POSIX/fish suffix preserves stdin, nonzero status and a live parent without wrapping C',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-31255-native-input-'))
    const env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CODEX_HOME: join(root, 'codex'),
      ORCA_E2E_USER_DATA_DIR: join(root, 'orca'),
      ORCA_E2E_HOME_DIR: root,
      ORCA_DISABLE_MACOS_LOGIN_SHELL: '1',
      BASH_ENV: '',
      ENV: ''
    }
    try {
      const path = join(root, 'setup.sh')
      await writeFile(
        path,
        `read -r answer; printf "input:%s\\n" "$answer"; trap 'printf "user-trap\\n"' EXIT; exit 17`
      )
      const command = buildSetupRunnerCommand(path, 'posix')
      for (const shell of ['/bin/bash', '/bin/zsh', '/opt/homebrew/bin/fish'].filter(existsSync)) {
        const family = shell.endsWith('/fish') ? 'fish' : 'posix'
        const native = appendNativeSetupCompletion(command, 'native:input', family)
        const status = family === 'fish' ? '$status' : '$?'
        const tail = `; printf 'parent-status:%s\\nparent-alive\\n' "${status}"`
        const run = (c: string) =>
          runProcess({
            program: shell,
            args: ['-c', c + tail],
            input: 'actual stdin\n',
            cwd: root,
            env,
            timeoutMs: 10_000
          })
        const original = await run(command)
        const observed = await run(native)
        expect(native.startsWith(`${command};`)).toBe(true)
        expect(observed.code, observed.stderr).toBe(0)
        expect(observed.stdout.replace(/\nORCA_SETUP_DONE:[^\n]+;\n/, '')).toBe(original.stdout)
        expect(observed.stdout).toContain('input:actual stdin')
        expect(observed.stdout).toContain('parent-status:17')
        let code: number | undefined
        createSetupCompletionScanner('native:input', (value) => {
          code = value
        }).scan(observed.stdout)
        expect(code).toBe(17)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
