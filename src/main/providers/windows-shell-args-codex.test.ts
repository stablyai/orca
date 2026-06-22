import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
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
import { join } from 'node:path'
import { buildWslInteractiveLoginShellCommand } from '../../shared/wsl-login-shell-command'
import { getWslCodexHistoryBootstrap, resolveWindowsShellLaunchArgs } from './windows-shell-args'

const hasBash = process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0
const itWithBash = hasBash ? it : it.skip
const hasZsh = process.platform !== 'win32' && spawnSync('zsh', ['--version']).status === 0
const itWithZsh = hasZsh ? it : it.skip

function quoteBashSingle(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function createFakeCodexBin(tempDir: string): string {
  const binDir = join(tempDir, 'bin')
  mkdirSync(binDir, { recursive: true })
  const codexPath = join(binDir, 'codex')
  writeFileSync(
    codexPath,
    `#!/usr/bin/env bash
printf 'CODEX_HOME=%s\\n' "$CODEX_HOME"
i=0
for arg in "$@"; do
  printf 'ARG%s=%s\\n' "$i" "$arg"
  i=$((i + 1))
done
`,
    'utf-8'
  )
  chmodSync(codexPath, 0o755)
  return binDir
}

function createFakeGetentBin(tempDir: string): string {
  const binDir = join(tempDir, 'getent-bin')
  mkdirSync(binDir, { recursive: true })
  const getentPath = join(binDir, 'getent')
  writeFileSync(
    getentPath,
    `#!/bin/sh
printf 'u:x:1000:1000::%s:%s\\n' "$HOME" "$ORCA_TEST_LOGIN_SHELL"
`,
    'utf-8'
  )
  chmodSync(getentPath, 0o755)
  return binDir
}

function expectFakeCodexSafetyOutput(output: string): void {
  expect(output).toContain('CODEX_HOME=/orca-managed-home')
  expect(output).toContain('ARG0=-c')
  expect(output).toContain('ARG1=history.persistence="save-all"')
  expect(output).toContain('ARG4=-c')
  expect(output).toContain('ARG5=history.persistence="none"')
  expect(output.indexOf('ARG1=history.persistence="save-all"')).toBeLessThan(
    output.indexOf('ARG5=history.persistence="none"')
  )
}

function expectSafetyBeforeTerminatorOutput(output: string): void {
  expect(output).toContain('CODEX_HOME=/orca-managed-home')
  expect(output).toContain('ARG0=resume')
  expect(output).toContain('ARG1=-c')
  expect(output).toContain('ARG2=history.persistence="save-all"')
  expect(output).toContain('ARG3=-c')
  expect(output).toContain('ARG4=history.persistence="none"')
  expect(output).toContain('ARG5=--')
  expect(output).toContain('ARG6=--help')
}

function runBootstrapWithFakeCodex(
  bootstrap: string,
  fakeBin: string,
  tempDir: string,
  shell = 'bash',
  includeFakeBinOnInitialPath = true
) {
  return spawnSync(shell, ['-c', bootstrap], {
    env: {
      ...process.env,
      ORCA_CODEX_HOME: '/orca-managed-home',
      CODEX_HOME: '/initial-home',
      HOME: tempDir,
      PATH: includeFakeBinOnInitialPath
        ? `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`
        : (process.env.PATH ?? '/usr/bin:/bin')
    },
    encoding: 'utf8'
  })
}

function runWslPostLoginBootstrapWithFakeCodex(command: string, fakeBin: string, tempDir: string) {
  return spawnSync(
    'sh',
    [
      '-c',
      [
        'export PATH=/usr/bin:/bin',
        'export CODEX_HOME=/profile-reset',
        getWslCodexHistoryBootstrap(),
        `export PATH="$PATH:${fakeBin}"`,
        command
      ].join('\n')
    ],
    {
      env: {
        ...process.env,
        ORCA_CODEX_HOME: '/orca-managed-home',
        HOME: tempDir
      },
      encoding: 'utf8'
    }
  )
}

describe('Windows Codex shell launch wrappers', () => {
  itWithBash('Git Bash bootstrap restores CODEX_HOME when startup files reset it', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-git-bash-codex-'))
    try {
      const fakeBin = createFakeCodexBin(tempDir)
      const result = resolveWindowsShellLaunchArgs(
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Users\\alice\\code',
        'C:\\Users\\alice'
      )
      const bootstrap = (result.shellArgs[1] ?? '').replace(
        '; exec bash --login -i',
        `; bash -l -c ${quoteBashSingle(
          'export CODEX_HOME=/profile-reset; codex -c \'history.persistence="save-all"\' resume session-1'
        )}`
      )
      const run = runBootstrapWithFakeCodex(bootstrap, fakeBin, tempDir)

      expect(run.status).toBe(0)
      expectFakeCodexSafetyOutput(run.stdout)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  itWithBash('Git Bash bootstrap sources login startup files once', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-git-bash-profile-'))
    try {
      const counterPath = join(tempDir, 'profile-count')
      writeFileSync(
        join(tempDir, '.bash_profile'),
        `count=0
if [[ -f ${quoteBashSingle(counterPath)} ]]; then
  count=$(cat ${quoteBashSingle(counterPath)})
fi
printf '%s' "$((count + 1))" > ${quoteBashSingle(counterPath)}
`,
        'utf-8'
      )
      const result = resolveWindowsShellLaunchArgs(
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Users\\alice\\code',
        'C:\\Users\\alice'
      )
      const bootstrap = (result.shellArgs[1] ?? '').replace(
        'exec bash --login -i',
        'bash --login -i -c true'
      )
      const run = spawnSync('bash', ['-c', bootstrap], {
        env: {
          ...process.env,
          ORCA_CODEX_HOME: '/orca-managed-home',
          HOME: tempDir
        },
        encoding: 'utf8'
      })

      expect(run.status).toBe(0)
      expect(existsSync(counterPath)).toBe(true)
      expect(readFileSync(counterPath, 'utf8')).toBe('1')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  itWithBash('Git Bash bootstrap inserts the safety override before --', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-git-bash-codex-'))
    try {
      const fakeBin = createFakeCodexBin(tempDir)
      const result = resolveWindowsShellLaunchArgs(
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Users\\alice\\code',
        'C:\\Users\\alice'
      )
      const bootstrap = (result.shellArgs[1] ?? '').replace(
        '; exec bash --login -i',
        `; bash -l -c ${quoteBashSingle(
          'codex resume -c \'history.persistence="save-all"\' -- --help'
        )}`
      )
      const run = runBootstrapWithFakeCodex(bootstrap, fakeBin, tempDir)

      expect(run.status).toBe(0)
      expectSafetyBeforeTerminatorOutput(run.stdout)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  itWithBash('WSL bootstrap restores CODEX_HOME inside the final login shell invocation', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-wsl-codex-'))
    try {
      const fakeBin = createFakeCodexBin(tempDir)
      const run = runWslPostLoginBootstrapWithFakeCodex(
        'codex -c \'history.persistence="save-all"\' resume session-1',
        fakeBin,
        tempDir
      )

      expect(run.status).toBe(0)
      expectFakeCodexSafetyOutput(run.stdout)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  itWithBash('WSL bootstrap inserts the safety override before --', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-wsl-codex-'))
    try {
      const fakeBin = createFakeCodexBin(tempDir)
      const run = runWslPostLoginBootstrapWithFakeCodex(
        'codex resume -c \'history.persistence="save-all"\' -- --help',
        fakeBin,
        tempDir
      )

      expect(run.status).toBe(0)
      expectSafetyBeforeTerminatorOutput(run.stdout)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  itWithBash('WSL bootstrap cleans up the temporary Codex wrapper directory on shell exit', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-wsl-codex-cleanup-'))
    try {
      const fakeBin = createFakeCodexBin(tempDir)
      const run = runWslPostLoginBootstrapWithFakeCodex(
        'printf "WRAPPER=%s\\n" "$ORCA_CODEX_WRAPPER_DIR"; codex resume session-1',
        fakeBin,
        tempDir
      )
      const wrapperDir = run.stdout.match(/^WRAPPER=(.+)$/m)?.[1]

      expect(run.status).toBe(0)
      expect(wrapperDir).toContain('/orca-codex-history.')
      expect(wrapperDir && existsSync(wrapperDir)).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  itWithBash(
    'WSL bash bootstrap preserves profile state after installing the Codex wrapper',
    () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'orca-wsl-codex-rc-'))
      try {
        const fakeBin = createFakeCodexBin(tempDir)
        const fakeGetentBin = createFakeGetentBin(tempDir)
        const bashPath = spawnSync('bash', ['-lc', 'command -v bash'], {
          encoding: 'utf8'
        }).stdout.trim()
        writeFileSync(join(tempDir, '.bashrc'), 'printf "BASHRC_SHOULD_NOT_LOAD\\n"\n', 'utf-8')
        writeFileSync(
          join(tempDir, '.bash_profile'),
          `export PATH=${quoteBashSingle(fakeBin)}:/usr/bin:/bin
export CODEX_HOME=/profile-reset
orca_profile_fn() { printf 'PROFILE_FN=ok\\n'; }
`,
          'utf-8'
        )
        const command = buildWslInteractiveLoginShellCommand(getWslCodexHistoryBootstrap())
        const run = spawnSync('sh', ['-c', command], {
          input:
            'orca_profile_fn\ncodex -c \'history.persistence="save-all"\' resume session-1\nprintf "WRAPPER=%s\\n" "$ORCA_CODEX_WRAPPER_DIR"\nexit 0\n',
          env: {
            ...process.env,
            ORCA_CODEX_HOME: '/orca-managed-home',
            ORCA_TEST_LOGIN_SHELL: bashPath,
            HOME: tempDir,
            PATH: `${fakeGetentBin}:${process.env.PATH ?? '/usr/bin:/bin'}`
          },
          encoding: 'utf8'
        })
        const wrapperDir = run.stdout.match(/^WRAPPER=(.+)$/m)?.[1]

        expect(run.status).toBe(0)
        expect(run.stdout).toContain('PROFILE_FN=ok')
        expect(run.stdout).not.toContain('BASHRC_SHOULD_NOT_LOAD')
        expectFakeCodexSafetyOutput(run.stdout)
        expect(wrapperDir).toContain('/orca-codex-history.')
        expect(wrapperDir && existsSync(wrapperDir)).toBe(false)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    }
  )

  itWithZsh(
    'WSL zsh bootstrap preserves custom ZDOTDIR startup files after installing the Codex wrapper',
    () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'orca-wsl-codex-zsh-'))
      try {
        const fakeBin = createFakeCodexBin(tempDir)
        const fakeGetentBin = createFakeGetentBin(tempDir)
        const customZdotdir = join(tempDir, '.config', 'zsh')
        mkdirSync(customZdotdir, { recursive: true })
        const zshPath = spawnSync('zsh', ['-lc', 'command -v zsh'], {
          encoding: 'utf8'
        }).stdout.trim()
        writeFileSync(
          join(tempDir, '.zshenv'),
          `export ZDOTDIR=${quoteBashSingle(customZdotdir)}\n`,
          'utf-8'
        )
        writeFileSync(
          join(customZdotdir, '.zprofile'),
          `export PATH=${quoteBashSingle(fakeBin)}:/usr/bin:/bin
export CODEX_HOME=/profile-reset
orca_zprofile_fn() { printf "ZPROFILE_FN=ok\\n"; }
`,
          'utf-8'
        )
        writeFileSync(
          join(customZdotdir, '.zshrc'),
          'orca_zshrc_fn() { printf "ZSHRC_FN=ok\\n"; }\n',
          'utf-8'
        )
        writeFileSync(join(customZdotdir, '.zlogin'), 'export CODEX_HOME=/zlogin-reset\n', 'utf-8')
        const command = buildWslInteractiveLoginShellCommand(getWslCodexHistoryBootstrap())
        const run = spawnSync('sh', ['-c', command], {
          input:
            'orca_zprofile_fn\ncodex -c \'history.persistence="save-all"\' resume session-1\nprintf "ZDOTDIR=%s\\n" "$ZDOTDIR"\nprintf "WRAPPER=%s\\n" "$ORCA_CODEX_WRAPPER_DIR"\nexit 0\n',
          env: {
            ...process.env,
            ORCA_CODEX_HOME: '/orca-managed-home',
            ORCA_TEST_LOGIN_SHELL: zshPath,
            HOME: tempDir,
            ZDOTDIR: tempDir,
            PATH: `${fakeGetentBin}:${process.env.PATH ?? '/usr/bin:/bin'}`
          },
          encoding: 'utf8',
          timeout: 5000
        })
        const wrapperDir = run.stdout.match(/^WRAPPER=(.+)$/m)?.[1]

        expect(run.status).toBe(0)
        expect(run.stdout).toContain('ZPROFILE_FN=ok')
        expect(run.stdout).toContain(`ZDOTDIR=${customZdotdir}`)
        expectFakeCodexSafetyOutput(run.stdout)
        expect(wrapperDir).toContain('/orca-codex-history.')
        expect(wrapperDir && existsSync(wrapperDir)).toBe(false)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    }
  )
})
