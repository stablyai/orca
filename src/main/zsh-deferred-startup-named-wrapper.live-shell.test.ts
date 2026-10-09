import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureOverlayRestoreWrappers } from '../relay/pty-shell-overlay-wrappers'
import { getDaemonZshWrapperSpec } from './daemon/daemon-zsh-shell-ready-wrapper-spec'
import { getZshShellReadyWrapperFile } from './providers/local-pty-shell-ready-wrapper-generation'
import { POSIX_SHELL_STARTUP_COMMAND_ENV } from './pty/posix-shell-startup-command'
import { encodeShellStartupFeatures, selectShellStartupFeatures } from './shell-startup-features'
import { ZSH_WRAPPER_DIR_MARKER_FILE } from './shell-templates'
import { buildZshStartupHook } from './zsh-startup-wrapper-builder'
import { hasZsh, MARKERS, runZshPty, ZSH_PATH } from './zsh-startup-hook-pty-harness'

const itWithZsh = hasZsh ? it : it.skip
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('zsh plugins that call deferred line-init by name', () => {
  itWithZsh.each(['local', 'daemon', 'relay'] as const)(
    'preserves the plugin call across prompts in a %s wrapper',
    async (transport) => {
      const home = mkdtempSync(join(tmpdir(), 'orca-zsh-named-wrapper-'))
      roots.push(home)
      const wrapperDir = join(home, 'wrapper')
      mkdirSync(wrapperDir)
      // zimfw/input copies the widget's function name into its own body.
      writeFileSync(
        join(home, '.zshrc'),
        `functions[orca_test_app_mode]=\${widgets[zle-line-init]#user:}'
  O_AM=$((\${O_AM:-0}+1))
  echoti smkx'
zle -N zle-line-init orca_test_app_mode
`
      )
      const wrapper =
        transport === 'local'
          ? getZshShellReadyWrapperFile()
          : transport === 'daemon'
            ? buildZshStartupHook(getDaemonZshWrapperSpec())
            : (() => {
                expect(ensureOverlayRestoreWrappers(wrapperDir)).toBe(true)
                return readFileSync(join(wrapperDir, 'zsh', '.zshenv'), 'utf8')
              })()
      writeFileSync(join(wrapperDir, '.zshenv'), wrapper)
      writeFileSync(join(wrapperDir, ZSH_WRAPPER_DIR_MARKER_FILE), '')
      const env: Record<string, string> = {
        HOME: home,
        USERPROFILE: home,
        PATH: '/usr/bin:/bin',
        DEBIAN_PREVENT_KEYBOARD_CHANGES: '1',
        ZDOTDIR: wrapperDir,
        ORCA_HISTFILE: join(home, 'scoped-history')
      }
      env.ORCA_SHELL_FEATURES = encodeShellStartupFeatures(
        selectShellStartupFeatures({
          shellPath: ZSH_PATH,
          env,
          hasStartupCommand: transport === 'local',
          waitsForShellReady: true,
          emitsStartupIdentity: false
        })
      )
      if (transport === 'local') {
        env[POSIX_SHELL_STARTUP_COMMAND_ENV] = 'O_SU=$((${O_SU:-0}+1))'
      }

      const result = await runZshPty({
        env,
        commands: [
          'true',
          'false',
          'O_STATUS=$?',
          '[[ ${functions[orca_test_app_mode]} == *__orca_deferred_line_init* ]]; O_CALL_REF=$?',
          '__orca_deferred_line_init; O_NOOP=$?',
          'O_INIT=${+functions[__orca_deferred_init]}'
        ],
        report: ['O_AM', 'O_CALL_REF', 'O_STATUS', 'O_NOOP', 'O_INIT', 'O_SU', 'HISTFILE']
      })

      expect(result.output, result.output).not.toContain('command not found')
      expect(result.output).toContain(MARKERS.ready)
      expect(Number(result.values.O_AM)).toBeGreaterThan(2)
      expect(result.values.O_CALL_REF).toBe('0')
      expect(result.values.O_STATUS).toBe('1')
      expect(result.values.O_NOOP).toBe('0')
      expect(result.values.O_INIT).toBe('0')
      expect(result.values.O_SU).toBe(transport === 'local' ? '1' : 'UNSET')
      expect(result.values.HISTFILE).toBe(join(home, 'scoped-history'))
    }
  )
})
