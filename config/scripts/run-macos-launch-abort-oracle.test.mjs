import { describe, expect, it } from 'vitest'
import {
  ALREADY_RUNNING_EXIT_CODE,
  SANDBOX_PROFILE,
  SCENARIOS,
  executableWrapperScript,
  judge,
  orderedScenarios,
  parseArgs
} from './run-macos-launch-abort-oracle.mjs'

function result(overrides) {
  return {
    scenario: 'serve-duplicate-sandboxed',
    attemptExitCode: ALREADY_RUNNING_EXIT_CODE,
    attemptSignal: null,
    ownerReady: true,
    newCrashReports: [],
    crashStackHasRegisterApplication: false,
    childOrcaJsRan: false,
    runtimeMetadataAfter: true,
    attemptReportedSigabrt: false,
    attemptDurationMs: 150,
    attemptStdout: '',
    attemptStderr: '',
    ...overrides
  }
}

const LAUNCH_ABORT_DIAGNOSTIC =
  'aborted with SIGABRT ... _RegisterApplication calls abort() ... Retrying cannot help: ...'

describe('macOS launch-abort oracle scenarios', () => {
  it('covers every supported CLI entrypoint into a GUI Electron main', () => {
    expect(SCENARIOS).toEqual([
      'serve-fresh-sandboxed',
      'serve-fresh-open',
      'serve-duplicate-sandboxed',
      'serve-duplicate-open',
      'open-duplicate',
      'recipe-json-duplicate'
    ])
  })

  it('denies exactly the Launch Services mach services and nothing else', () => {
    expect(SANDBOX_PROFILE).toContain('(allow default)')
    for (const service of [
      'com.apple.lsd.mapdb',
      'com.apple.lsd.modifydb',
      'com.apple.lsd.openurl',
      'com.apple.coreservices.launchservicesd'
    ]) {
      expect(SANDBOX_PROFILE).toContain(`(deny mach-lookup (global-name "${service}"))`)
    }
  })

  it('rejects an unknown scenario instead of silently running fewer', () => {
    expect(() => parseArgs(['--electron', 'e', '--cli', 'c', '--scenario', 'typo'])).toThrow(
      /unknown scenario/
    )
  })

  it('runs every scenario when none is named', () => {
    expect(parseArgs(['--electron', 'e', '--cli', 'c']).scenarios).toEqual(SCENARIOS)
  })

  it('runs the shared-owner scenarios before anything that aborts', () => {
    // Why: an abort wedges the next GUI launch, so the owner must be started
    // before any fresh scenario runs no matter how the caller ordered them.
    expect(orderedScenarios(['serve-fresh-sandboxed', 'open-duplicate'])).toEqual([
      'open-duplicate',
      'serve-fresh-sandboxed'
    ])
    expect(orderedScenarios(SCENARIOS).slice(0, 4)).toEqual([
      'serve-duplicate-sandboxed',
      'serve-duplicate-open',
      'open-duplicate',
      'recipe-json-duplicate'
    ])
  })

  it('pins the spawned Electron to the run profile so a packaged arm cannot touch the real one', () => {
    // Why: a packaged main ignores ORCA_DEV_USER_DATA_PATH, so `--user-data-dir`
    // is the only isolation the CLI-spawned child gets.
    const script = executableWrapperScript('/base/Orca.app/Contents/MacOS/Orca', '/tmp/profile')

    expect(script).toContain("exec '/base/Orca.app/Contents/MacOS/Orca'")
    expect(script).toContain("'--user-data-dir=/tmp/profile'")
    expect(script.trimEnd().endsWith('"$@"')).toBe(true)
  })

  it('keeps a quote in a path inside the quoted word', () => {
    // Why: an unescaped quote closes the quoting, and the rest of a worktree
    // path named e.g. `jinwoo's orca` would run as shell code.
    const script = executableWrapperScript("/base/jinwoo's orca/Electron", "/tmp/o'brien")

    expect(script).toContain(`exec '/base/jinwoo'\\''s orca/Electron'`)
    expect(script).toContain(`'--user-data-dir=/tmp/o'\\''brien'`)
  })

  it('refuses a flag whose value is missing rather than labelling a run undefined', () => {
    expect(() => parseArgs(['--electron', 'e', '--cli', 'c', '--label'])).toThrow(
      /--label requires a value/
    )
    expect(() => parseArgs(['--electron', '--cli', 'c'])).toThrow(/--electron requires a value/)
  })
})

describe('judge', () => {
  it('passes a duplicate serve that refuses before spawning', () => {
    expect(judge(result({}))).toEqual([])
  })

  it('fails the pre-fix behaviour: a second main that aborts before JS', () => {
    // Why: this is latest main on macOS — exit 1 with a bare SIGABRT and an
    // _RegisterApplication crash report, which is what supervisors retry into
    // a crash loop.
    expect(
      judge(
        result({
          attemptExitCode: 1,
          attemptReportedSigabrt: true,
          crashStackHasRegisterApplication: true,
          newCrashReports: ['Electron-2026-08-14-000000.ips']
        })
      )
    ).toEqual([
      'a second Electron main was launched against an owned profile and aborted',
      `expected exit ${ALREADY_RUNNING_EXIT_CODE}, got 1`
    ])
  })

  it('fails a duplicate that exits for the wrong reason', () => {
    expect(judge(result({ attemptExitCode: 0 }))).toContain(
      `expected exit ${ALREADY_RUNNING_EXIT_CODE}, got 0`
    )
  })

  it('refuses to grade a duplicate scenario whose owner never came up', () => {
    // Why: an ungraded run must not also emit exit-code verdicts, or a harness
    // failure reads as a product failure.
    expect(judge(result({ ownerReady: false, attemptExitCode: 1 }))).toEqual([
      'the owning runtime never became ready, so nothing was tested'
    ])
  })

  it('requires --recipe-json to take the same refusal path as plain serve', () => {
    expect(judge(result({ scenario: 'recipe-json-duplicate', attemptExitCode: 1 }))).toContain(
      `expected exit ${ALREADY_RUNNING_EXIT_CODE}, got 1`
    )
  })

  it('accepts a fresh serve that converts the abort into one actionable failure', () => {
    expect(
      judge(
        result({
          scenario: 'serve-fresh-sandboxed',
          ownerReady: null,
          attemptExitCode: 1,
          attemptReportedSigabrt: true,
          attemptStderr: LAUNCH_ABORT_DIAGNOSTIC
        })
      )
    ).toEqual([])
  })

  it('fails a fresh serve that dies on a bare SIGABRT', () => {
    expect(
      judge(
        result({
          scenario: 'serve-fresh-sandboxed',
          ownerReady: null,
          attemptExitCode: 1,
          attemptReportedSigabrt: true
        })
      )
    ).toEqual([
      'the attempt died on a bare SIGABRT with no classified diagnostic',
      'the single failure did not carry an actionable diagnostic'
    ])
  })

  it('fails a fresh serve that reports success it cannot have achieved', () => {
    expect(
      judge(
        result({
          scenario: 'serve-fresh-sandboxed',
          ownerReady: null,
          attemptExitCode: 0,
          attemptStderr: LAUNCH_ABORT_DIAGNOSTIC
        })
      )
    ).toContain('a serve that cannot register with Launch Services must not report success')
  })

  it('fails the pre-fix open that waited out its window timeout', () => {
    expect(
      judge(
        result({
          scenario: 'open-duplicate',
          attemptExitCode: 1,
          attemptDurationMs: 15_336,
          attemptStdout: '{"error":{"code":"runtime_open_timeout"}}'
        })
      )
    ).toEqual([
      'took 15336ms; a classified refusal must be prompt',
      'the refusal carried no machine-readable cause'
    ])
  })

  it('accepts either classified refusal from a prompt open', () => {
    for (const code of ['runtime_open_failed', 'desktop_activation_blocked']) {
      expect(
        judge(
          result({
            scenario: 'open-duplicate',
            attemptExitCode: 1,
            attemptDurationMs: 200,
            attemptStdout: `{"error":{"code":"${code}"}}`
          })
        )
      ).toEqual([])
    }
  })

  it('fails an unsandboxed fresh serve that never reached Orca JavaScript', () => {
    expect(
      judge(
        result({
          scenario: 'serve-fresh-open',
          ownerReady: null,
          attemptExitCode: null,
          childOrcaJsRan: false
        })
      )
    ).toContain('an unsandboxed fresh serve never reached Orca JavaScript')
  })
})
