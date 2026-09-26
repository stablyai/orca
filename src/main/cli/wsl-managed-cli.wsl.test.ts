import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { getAppEnvironment } from '../../shared/app-environment'
import { isManagedWslCliAvailable } from './wsl-managed-cli-availability'

vi.mock('../persistence', () => ({
  getCanonicalUserDataPath: () => getAppEnvironment().getPath('userData')
}))
vi.mock('../daemon/daemon-provider-state', () => ({
  daemonOwnsFreshPersistentPtys: () => false,
  getDaemonProvider: () => null
}))
import { runProcess } from '../../shared/child-process/run-process'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { addOrcaWslInteropEnv } from '../pty/wsl-orca-env'
import { getManagedWslCliDir } from './wsl-managed-cli'
import { buildLocalShellReadyWrapperFiles } from '../providers/local-pty-shell-ready-wrapper-fileset'

// Explicit opt-in: never require a developer's WSL installation for unit tests.
const enabled = process.platform === 'win32' && process.env.ORCA_TEST_MANAGED_WSL === '1'
const FIXTURE_CLI =
  'if(process.argv.includes("--exit"))process.exit(23); console.error("bridge stderr"); console.log(JSON.stringify({argv:process.argv.slice(2),owner:process.env.ORCA_USER_DATA_PATH,handle:process.env.ORCA_TERMINAL_HANDLE}))'

async function withManagedCli(
  run: (fixture: {
    env: Record<string, string>
    guestRoot: string
    root: string
    userDataPath: string
    wsl: (args: string[], input?: string) => ReturnType<typeof runProcess>
  }) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "orca WSL's managed CLI "))
  const distro = process.env.ORCA_TEST_WSL_DISTRO || undefined
  const userDataPath = join(root, 'user data 张三 O\u2019Brien')
  const env: Record<string, string> = { ORCA_BACKGROUND_LAUNCH: '1' }
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  const wsl = (args: string[], input?: string) =>
    runProcess({
      program: 'wsl.exe',
      args: buildWslExecArgs(distro, args),
      env,
      cwd: root,
      input,
      timeoutMs: 30_000
    })
  const snapshot = () =>
    wsl([
      'sh',
      '-c',
      'for file in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.zshenv" "$HOME/.local/bin/orca" "$HOME/.local/bin/orca-ide" "$HOME/.local/bin/orca-dev" "$HOME/.local/share/orca/orca-wsl-bridge.ps1"; do if [ -f "$file" ]; then sha256sum "$file"; fi; done; printf "PATH=%s\\n" "$PATH"'
    ])
  try {
    const before = await snapshot()
    expect(before.code, before.stderr).toBe(0)
    mkdirSync(join(root, 'out', 'cli'), { recursive: true })
    writeFileSync(join(root, 'out', 'cli', 'index.js'), FIXTURE_CLI)
    for (const [path, content] of buildLocalShellReadyWrapperFiles(join(root, 'wrapper'))) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }
    const translated = await wsl(['wslpath', '-u', root])
    expect(translated.code, translated.stderr).toBe(0)
    installFakeAppEnvironment({ getPath: () => userDataPath, getAppPath: () => root })
    const directory = getManagedWslCliDir({ isPackaged: false, userDataPath })
    expect(directory).not.toBeNull()
    Object.assign(env, {
      ORCA_WSL_CLI_DIR: directory ?? '',
      ORCA_CLI_COMMAND: 'orca-dev',
      ORCA_TERMINAL_HANDLE: 'term_managed_fixture'
    })
    addOrcaWslInteropEnv(env)
    await run({ env, guestRoot: translated.stdout.trim(), root, userDataPath, wsl })
    expect((await snapshot()).stdout).toBe(before.stdout)
  } finally {
    await removeTree(root)
  }
}

it.skipIf(!enabled)(
  'executes the managed bridge after bash startup resets PATH, without guest registration',
  () =>
    withManagedCli(async ({ env, guestRoot, root, userDataPath, wsl }) => {
      writeFileSync(join(root, '.bash_profile'), 'export PATH=/usr/bin:/bin\n')
      const shell = (command: string) =>
        wsl([
          'env',
          `HOME=${guestRoot}`,
          'PATH=/usr/bin:/bin',
          'bash',
          '--rcfile',
          `${guestRoot}/wrapper/bash/rcfile`,
          '-ic',
          command
        ])

      const result = await shell('orca-dev "two words" "literal $" | cat')
      expect(result.code, result.stderr).toBe(0)
      expect(result.stderr).toContain('bridge stderr')
      expect(result.stdout).toContain('"argv":["two words","literal $"]')
      expect(result.stdout).toContain(JSON.stringify(userDataPath))
      expect(result.stdout).toContain('"handle":"term_managed_fixture"')
      expect((await shell('orca-dev --exit')).code).toBe(23)

      env.ORCA_WSL_CLI_DIR = join(root, 'missing-cli')
      // An unusable CLI warns but never blocks the shell.
      const missing = await shell('echo SHELL_CONTINUED')
      expect(missing.code).toBe(0)
      expect(missing.stdout).toContain('SHELL_CONTINUED')
      expect(missing.stderr).toContain('Check WSL Windows-drive mount options')
    }),
  90_000
)

// Why a PTY: the zsh restore runs from the first-prompt hook, which `zsh -c` never reaches.
it.skipIf(!enabled)(
  'executes the managed bridge from an interactive zsh after .zshrc resets PATH',
  (ctx) =>
    withManagedCli(async ({ guestRoot, root, userDataPath, wsl }) => {
      if ((await wsl(['sh', '-c', 'command -v zsh && command -v script'])).code !== 0) {
        ctx.skip()
      }
      writeFileSync(join(root, '.zshrc'), 'export PATH=/usr/bin:/bin\n')
      const result = await wsl(
        [
          'env',
          `HOME=${guestRoot}`,
          'PATH=/usr/bin:/bin',
          `ZDOTDIR=${guestRoot}/wrapper/zsh`,
          'script',
          '-qec',
          'zsh -l',
          '/dev/null'
        ],
        `orca-dev "two words" > "$HOME/zsh-out"; print -r -- "path=$PATH" >> "$HOME/zsh-out"; exit\n`
      )
      expect(result.code, result.stderr).toBe(0)
      const output = await wsl(['cat', `${guestRoot}/zsh-out`])
      expect(output.stdout).toContain('"argv":["two words"]')
      expect(output.stdout).toContain(JSON.stringify(userDataPath))
      expect(output.stdout).toMatch(/path=\/mnt\/.*wsl-managed-cli\/[0-9a-f]{20}:\/usr\/bin:\/bin/)
    }),
  90_000
)

it.skipIf(!enabled)(
  'confirms managed CLI availability through the real distro and bridge without guest registration',
  () =>
    withManagedCli(async ({ userDataPath }) => {
      vi.stubEnv('ORCA_USER_DATA_PATH', userDataPath)
      try {
        expect(await isManagedWslCliAvailable(process.env.ORCA_TEST_WSL_DISTRO || undefined)).toBe(
          true
        )
      } finally {
        vi.unstubAllEnvs()
      }
    }),
  90_000
)
