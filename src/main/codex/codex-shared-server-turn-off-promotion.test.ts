import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import type { ProcessResult, ProcessSpec } from '../../shared/child-process/run-process'

// Why: temp homes exceed sun_path on macOS but not on Linux; keep asserted config bytes host-independent.
vi.mock('./codex-daemon-socket-path-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyCodexDaemonSocketGuard: (config: string) => config
}))

const mocks = vi.hoisted(() => ({
  homedir: vi.fn<() => string>(),
  runProcess: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>()
}))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  homedir: mocks.homedir
}))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: mocks.runProcess }))

import { disableCodexSharedServerAutoStartOnOrcaMirror } from './codex-shared-server-fix'
import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'
import { upsertTableSettingsInContent } from './codex-config-settings-upsert'

const FILE_NAME = process.platform === 'win32' ? 'codex.exe' : 'codex'
let tmpHome: string
let userDataDir: string
let previousUserDataPath: string | undefined

const systemConfigPath = (): string => join(tmpHome, '.codex', 'config.toml')
const mirrorHome = (): string => join(userDataDir, 'codex-runtime-home', 'home')
const mirrorConfigPath = (): string => join(mirrorHome(), 'config.toml')
const baselinePath = (): string => join(mirrorHome(), '.orca-config-settings-baseline.json')
const fakeCodex = (): string =>
  join(mirrorHome(), 'packages', 'app-server-daemon', 'current', 'bin', FILE_NAME)
const readSystemConfig = (): string => readFileSync(systemConfigPath(), 'utf-8')
const readMirrorConfig = (): string => readFileSync(mirrorConfigPath(), 'utf-8')

function writeSystemConfig(content: string): void {
  mkdirSync(join(tmpHome, '.codex'), { recursive: true })
  writeFileSync(systemConfigPath(), content, 'utf-8')
}

/** Rewrites the baseline as an Orca from before `daemon_auto_start` was promoted wrote it. */
function forgetKeyInBaseline(): void {
  const baseline = JSON.parse(readFileSync(baselinePath(), 'utf-8'))
  delete baseline.settings['features.daemon_auto_start']
  writeFileSync(baselinePath(), JSON.stringify(baseline), 'utf-8')
}

// Fake `codex`: the disable writes the mirror like Codex 0.159.3 does; the list reads it back.
function fakeCodexRun(spec: ProcessSpec): Promise<ProcessResult> {
  if (spec.program !== fakeCodex() || spec.env?.CODEX_HOME !== mirrorHome()) {
    throw new Error(`refusing an unexpected Codex: ${spec.program}`)
  }
  const done = (stdout = ''): Promise<ProcessResult> =>
    Promise.resolve({ code: 0, signal: null, stdout, stderr: '', timedOut: false })
  if ((spec.args ?? []).join(' ') === 'features disable daemon_auto_start') {
    const existing = existsSync(mirrorConfigPath()) ? readMirrorConfig() : ''
    writeFileSync(
      mirrorConfigPath(),
      upsertTableSettingsInContent(existing, 'features', new Map([['daemon_auto_start', 'false']]))
    )
    return done()
  }
  const enabled = !/^daemon_auto_start = false$/m.test(readMirrorConfig())
  return done(`daemon_auto_start  experimental  ${enabled}\n`)
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'orca-turn-off-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-turn-off-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  mocks.homedir.mockReturnValue(tmpHome)
  // Why: promotion writes into homedir()/.codex; refuse to run against the real one.
  if (homedir() !== tmpHome) {
    throw new Error('node:os homedir mock is not active; refusing to touch the real ~/.codex')
  }
  mkdirSync(join(fakeCodex(), '..'), { recursive: true })
  writeFileSync(fakeCodex(), '')
  mocks.runProcess.mockImplementation(fakeCodexRun)
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

const ORDINARY = 'model = "gpt-5"\n\n[tui]\ntheme = "dark"\n'

describe('Turn off on Orca mirror home', () => {
  it.each([
    ['a baseline from an older Orca', forgetKeyInBaseline],
    ['a baseline from this build', () => {}]
  ])('promotes false to ~/.codex at once under %s', async (_label, arrangeBaseline) => {
    writeSystemConfig(ORDINARY)
    syncSystemConfigIntoManagedCodexHome()
    arrangeBaseline()

    expect(await disableCodexSharedServerAutoStartOnOrcaMirror(mirrorHome())).toBe(true)

    expect(mocks.runProcess.mock.calls.map(([spec]) => spec.program)).toEqual([
      fakeCodex(),
      fakeCodex()
    ])
    expect(readSystemConfig()).toBe(`${ORDINARY}\n[features]\ndaemon_auto_start = false\n`)
    expect(readMirrorConfig()).toContain('daemon_auto_start = false')
    // Why: a later launch pass mirrors the promoted source, so the setting must survive it.
    syncSystemConfigIntoManagedCodexHome()
    expect(readMirrorConfig()).toContain('daemon_auto_start = false')
  })

  // Why: the older Orca had mirrored `true` already, so the pass before records it as
  // the ancestor and Turn off is promoted like any in-Codex change, as on a fresh baseline.
  it('replaces an explicit true in ~/.codex, as it would on a fresh baseline', async () => {
    writeSystemConfig('model = "gpt-5"\n\n[features]\ndaemon_auto_start = true\n')
    syncSystemConfigIntoManagedCodexHome()
    forgetKeyInBaseline()

    expect(await disableCodexSharedServerAutoStartOnOrcaMirror(mirrorHome())).toBe(true)

    expect(readSystemConfig()).toBe('model = "gpt-5"\n\n[features]\ndaemon_auto_start = false\n')
  })

  it('keeps an explicit true the mirror already disagreed with, as a recorded conflict', async () => {
    writeSystemConfig('[features]\ndaemon_auto_start = true\n')
    syncSystemConfigIntoManagedCodexHome()
    forgetKeyInBaseline()
    writeFileSync(mirrorConfigPath(), '[features]\ndaemon_auto_start = false\n')

    expect(await disableCodexSharedServerAutoStartOnOrcaMirror(mirrorHome())).toBe(true)

    // Why: with no recorded ancestor neither side is known to be newer, so both stay.
    expect(readSystemConfig()).toBe('[features]\ndaemon_auto_start = true\n')
    expect(readMirrorConfig()).toContain('daemon_auto_start = false')
  })

  it('still fixes the pane when ~/.codex/config.toml is missing and the passes skip', async () => {
    writeSystemConfig(ORDINARY)
    syncSystemConfigIntoManagedCodexHome()
    forgetKeyInBaseline()
    rmSync(systemConfigPath())
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await disableCodexSharedServerAutoStartOnOrcaMirror(mirrorHome())).toBe(true)

    expect(existsSync(systemConfigPath())).toBe(false)
    expect(readMirrorConfig()).toContain('daemon_auto_start = false')
  })
})
