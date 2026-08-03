import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { nativeIbusEngineInputProfiles } from '../../tests/e2e/terminal-ibus-engine-input-profiles'
import { terminalIbusEngineProfiles } from './terminal-ibus-engine-profiles.mjs'

const projectDir = resolve(import.meta.dirname, '../..')

describe('terminal IME e2e workflow', () => {
  const workflow = parse(
    readFileSync(join(projectDir, '.github/workflows/terminal-ime-e2e.yml'), 'utf8')
  )
  const matrix = workflow.jobs['linux-x11'].strategy.matrix.include

  it('runs only on schedule or manual dispatch', () => {
    expect(workflow.on.pull_request).toBeUndefined()
    expect(workflow.on.workflow_dispatch).toBeNull()
    expect(workflow.on.schedule).toEqual([{ cron: '30 9 * * *' }])
  })

  // The session config and the keystroke scripts live in different files and are
  // joined only by this id at runtime, so a rename in one is invisible until CI.
  it('describes the same engines in the session and input profiles', () => {
    expect(Object.keys(nativeIbusEngineInputProfiles).sort()).toEqual(
      Object.keys(terminalIbusEngineProfiles).sort()
    )
    for (const [engineId, profile] of Object.entries(terminalIbusEngineProfiles)) {
      expect(nativeIbusEngineInputProfiles[engineId].ibusEngineName).toBe(profile.ibusEngineName)
      expect(nativeIbusEngineInputProfiles[engineId].expectationsVerified).toBe(
        profile.expectationsVerified
      )
    }
  })

  it('runs every profiled engine as its own matrix leg', () => {
    expect(matrix.map((leg) => leg.engine).sort()).toEqual(
      Object.keys(terminalIbusEngineProfiles).sort()
    )
    for (const leg of matrix) {
      expect(leg['apt-package']).toBe(terminalIbusEngineProfiles[leg.engine].aptPackage)
    }
    // One unverified engine's candidate drifting must not mask a regression in
    // hangul, the only leg with recorded expectations.
    expect(workflow.jobs['linux-x11'].strategy['fail-fast']).toBe(false)
  })

  it('installs the leg engine and X11 input tools', () => {
    const runs = workflow.jobs['linux-x11'].steps
      .map((step) => step.run)
      .filter((run) => typeof run === 'string')
    const installRun = runs.find((run) => run.includes('apt-get install'))

    expect(installRun).toBeDefined()
    expect(installRun).toContain('${{ matrix.apt-package }}')
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
    expect(runs[nativeIndex]).toContain('--engine=${{ matrix.engine }}')
  })

  // upload-artifact rejects a duplicate name, so a shared one fails every leg
  // after the first.
  it('uploads evidence under a per-engine artifact name', () => {
    const upload = workflow.jobs['linux-x11'].steps.find((step) =>
      step.uses?.startsWith('actions/upload-artifact@')
    )

    expect(upload.with.name).toContain('${{ matrix.engine }}')
  })

  it('keeps IBus lifecycle scoped to owned processes', () => {
    const runner = readFileSync(
      join(projectDir, 'config/scripts/run-terminal-ibus-engine-e2e.mjs'),
      'utf8'
    )

    expect(runner).toContain(
      "['--xim', '--verbose', '--panel=disable', '--emoji-extension=disable']"
    )
    expect(runner).toContain("spawn('xfwm4', ['--compositor=off']")
    expect(runner).toContain("process.kill(-processGroupId, 'SIGTERM')")
    expect(runner).toContain("process.kill(-processGroupId, 'SIGKILL')")
    expect(runner).toContain('const killDeadline = Date.now() + processKillTimeoutMs')
    expect(runner).toMatch(/'test:e2e:headful',\s*'--workers=1',\s*'--',\s*nativeSpecPath/)
    expect(runner).not.toContain("'--replace'")
    expect(runner).not.toContain('killall')
    expect(runner).not.toContain('pkill')
  })

  it('keeps the hangul session config that the recorded expectations were taken under', () => {
    expect(terminalIbusEngineProfiles.hangul.gsettings).toEqual([
      ['org.freedesktop.ibus.engine.hangul', 'initial-input-mode', 'hangul'],
      ['org.freedesktop.ibus.engine.hangul', 'hangul-keyboard', '2']
    ])
    expect(terminalIbusEngineProfiles.hangul.expectationsVerified).toBe(true)
  })

  it('bounds blocking native input commands', () => {
    const nativeSpec = readFileSync(
      join(projectDir, 'tests/e2e/terminal-ibus-engine-native.spec.ts'),
      'utf8'
    )

    expect(nativeSpec.match(/timeout: NATIVE_COMMAND_TIMEOUT_MS/g)).toHaveLength(3)
  })
})
