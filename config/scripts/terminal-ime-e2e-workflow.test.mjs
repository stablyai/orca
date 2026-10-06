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
    expect(workflow.on.workflow_dispatch.inputs.diagnose_wayland_input).toMatchObject({
      required: false,
      type: 'boolean',
      default: false
    })
    expect(workflow.on.schedule).toEqual([{ cron: '30 9 * * *' }])
    expect(workflow.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
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

  it('runs native Wayland independently with CJK fonts and retained evidence', () => {
    const job = workflow.jobs['linux-wayland']
    expect(job.needs).toBeUndefined()
    const install = job.steps.find((step) => step.run?.includes('apt-get install')).run
    for (const tool of ['gnome-shell', 'ibus-hangul', 'fonts-noto-cjk', 'xwininfo']) {
      expect(install).toContain(tool === 'xwininfo' ? 'x11-utils' : tool)
    }
    expect(job.steps.find((step) => step.run?.includes('--nested-wayland')).run).toBe(
      'node config/scripts/run-terminal-ibus-hangul-e2e.mjs --nested-wayland'
    )
    const upload = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact'))
    expect(upload.if).toBe('always()')
    expect(upload.with.name).toBe('terminal-wayland-ime-evidence')
  })
})
