import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')

describe('terminal IME e2e workflow', () => {
  const workflow = parse(
    readFileSync(join(projectDir, '.github/workflows/terminal-ime-e2e.yml'), 'utf8')
  )
  const linuxJob = workflow.jobs.linux

  it('runs only on schedule or manual dispatch', () => {
    expect(workflow.on.pull_request).toBeUndefined()
    expect(workflow.on.workflow_dispatch).toBeNull()
    expect(workflow.on.schedule).toEqual([{ cron: '30 9 * * *' }])
  })

  it('installs native IBus and Fcitx5 engines with X11 input tools', () => {
    const runs = linuxJob.steps.map((step) => step.run).filter((run) => typeof run === 'string')
    const installRun = runs.find((run) => run.includes('apt-get install'))

    expect(installRun).toBeDefined()
    expect(installRun).toContain('ibus-hangul')
    expect(installRun).toContain('ibus-libpinyin')
    expect(installRun).toContain('fcitx5-chinese-addons')
    expect(installRun).toContain('fcitx5-frontend-gtk3')
    expect(installRun).toContain('fcitx5-hangul')
    expect(installRun).toContain('sway')
    expect(installRun).toContain('wtype')
    expect(installRun).toContain('xdotool')
    expect(installRun).toContain('xfwm4')
    expect(installRun).toContain('xvfb')
    expect(installRun).toContain('dbus-x11')
    expect(installRun).toContain('dconf-gsettings-backend')
    expect(installRun).toContain('libglib2.0-bin')
  })

  it('pins X11 to Ubuntu 22.04 and Wayland to a current wlroots stack', () => {
    expect(linuxJob.strategy.matrix.include).toEqual([
      { label: 'X11', os: 'ubuntu-22.04', display_server: 'x11' },
      { label: 'Wayland', os: 'ubuntu-24.04', display_server: 'wayland' }
    ])
  })

  it('runs both native framework suites before deterministic boundaries', () => {
    const steps = linuxJob.steps
    const deterministicIndex = steps.findIndex((step) =>
      step.run?.includes('terminal-ime-exact-byte.spec.ts')
    )
    const nativeIndexes = steps
      .map((step, index) => (step.run?.includes('test:e2e:terminal-ime-native') ? index : -1))
      .filter((index) => index >= 0)

    expect(deterministicIndex).toBeGreaterThanOrEqual(0)
    expect(nativeIndexes).toHaveLength(3)
    expect(nativeIndexes.every((index) => deterministicIndex > index)).toBe(true)
    expect(steps.some((step) => step.with?.name === 'terminal-ime-native-evidence')).toBe(true)
    expect(steps.some((step) => step.with?.name === 'terminal-ime-native-fcitx5-evidence')).toBe(
      true
    )
    expect(
      steps.some((step) => step.with?.name === 'terminal-ime-native-fcitx5-wayland-evidence')
    ).toBe(true)
  })

  it('keeps native input framework lifecycle scoped to owned processes', () => {
    const runner = readFileSync(
      join(projectDir, 'config/scripts/run-terminal-linux-ime-e2e.mjs'),
      'utf8'
    )

    expect(runner).toContain(
      "['--xim', '--verbose', '--panel=disable', '--emoji-extension=disable']"
    )
    expect(runner).toContain("isWayland ? ['-c', '/dev/null'] : ['--compositor=off']")
    expect(runner).toContain("['initial-input-mode', 'hangul']")
    expect(runner).toContain("['hangul-keyboard', '2']")
    expect(runner).toContain("await waitForIbusEngine(inputMethodProcess, 'libpinyin')")
    expect(runner).toContain("inputFramework === 'ibus' ? 'ibus-daemon' : 'fcitx5'")
    expect(runner).toContain("['--disable=wayland']")
    expect(runner).toContain("WLR_BACKENDS: 'headless'")
    expect(runner).toContain("WLR_LIBINPUT_NO_DEVICES: '1'")
    expect(runner).toContain("for (const engine of ['hangul', 'pinyin'])")
    expect(runner).toContain("'org.freedesktop.DBus.NameHasOwner'")
    expect(runner).toContain("'org.fcitx.Fcitx5'")
    expect(runner).not.toContain("['--check']")
    expect(runner.match(/spawnSync\('ibus', \['engine', engine\]/g)).toHaveLength(1)
    expect(runner).toContain("process.kill(-processGroupId, 'SIGTERM')")
    expect(runner).toContain("process.kill(-processGroupId, 'SIGKILL')")
    expect(runner).toContain('const killDeadline = Date.now() + processKillTimeoutMs')
    expect(runner).toMatch(
      /'test:e2e:headful',[\s\S]*'--workers=1',[\s\S]*'--',[\s\S]*'tests\/e2e\/terminal-linux-ime-native\.spec\.ts'/
    )
    expect(runner).not.toContain("'--replace'")
    expect(runner).not.toContain('killall')
    expect(runner).not.toContain('pkill')
  })

  it('bounds blocking native input commands', () => {
    const nativeSpec = readFileSync(
      join(projectDir, 'tests/e2e/terminal-linux-ime-native.spec.ts'),
      'utf8'
    )

    expect(nativeSpec.match(/timeout: NATIVE_COMMAND_TIMEOUT_MS/g)).toHaveLength(9)
    expect(nativeSpec).toContain('{ timeout: 20_000 }')
  })
})
