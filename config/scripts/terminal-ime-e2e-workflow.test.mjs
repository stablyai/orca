import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')

describe('terminal IME e2e workflow', () => {
  const workflow = parse(
    readFileSync(join(projectDir, '.github/workflows/terminal-ime-e2e.yml'), 'utf8')
  )

  it('runs only on schedule or manual dispatch', () => {
    expect(workflow.on.pull_request).toBeUndefined()
    expect(workflow.on.workflow_dispatch).toBeNull()
    expect(workflow.on.schedule).toEqual([{ cron: '30 9 * * *' }])
  })

  it('installs native IBus Hangul and X11 input tools', () => {
    const runs = workflow.jobs['linux-x11'].steps
      .map((step) => step.run)
      .filter((run) => typeof run === 'string')
    const installRun = runs.find((run) => run.includes('apt-get install'))

    expect(installRun).toBeDefined()
    expect(installRun).toContain('ibus-hangul')
    expect(installRun).toContain('xdotool')
    expect(installRun).toContain('xfwm4')
    expect(installRun).toContain('xvfb')
    expect(installRun).toContain('dbus-x11')
    expect(installRun).toContain('dconf-gsettings-backend')
    expect(installRun).toContain('libglib2.0-bin')
  })

  it('runs deterministic boundaries before the real IBus suite', () => {
    const runs = workflow.jobs['linux-x11'].steps
      .map((step) => step.run)
      .filter((run) => typeof run === 'string')
    const deterministicIndex = runs.findIndex((run) =>
      run.includes('terminal-ime-exact-byte.spec.ts')
    )
    const nativeIndex = runs.findIndex((run) => run.includes('test:e2e:terminal-ime-native'))

    expect(deterministicIndex).toBeGreaterThanOrEqual(0)
    expect(nativeIndex).toBeGreaterThan(deterministicIndex)
  })

  it('keeps IBus lifecycle scoped to owned processes', () => {
    const runner = readFileSync(
      join(projectDir, 'config/scripts/run-terminal-ibus-hangul-e2e.mjs'),
      'utf8'
    )

    expect(runner).toContain(
      "['--xim', '--verbose', '--panel=disable', '--emoji-extension=disable']"
    )
    expect(runner).toContain("spawn('xfwm4', ['--compositor=off']")
    expect(runner).toContain("['initial-input-mode', 'hangul']")
    expect(runner).toContain("['hangul-keyboard', '2']")
    expect(runner).toContain("process.kill(-processGroupId, 'SIGTERM')")
    expect(runner).toContain("process.kill(-processGroupId, 'SIGKILL')")
    expect(runner).toContain('const killDeadline = Date.now() + processKillTimeoutMs')
    expect(runner).toMatch(
      /'test:e2e:headful',\s*'--workers=1',\s*'--',\s*'tests\/e2e\/terminal-ibus-hangul-native\.spec\.ts'/
    )
    expect(runner).not.toContain("'--replace'")
    expect(runner).not.toContain('killall')
    expect(runner).not.toContain('pkill')
  })

  it('bounds blocking native input commands', () => {
    const nativeSpec = readFileSync(
      join(projectDir, 'tests/e2e/terminal-ibus-hangul-native.spec.ts'),
      'utf8'
    )

    expect(nativeSpec.match(/timeout: NATIVE_COMMAND_TIMEOUT_MS/g)).toHaveLength(3)
  })
})
