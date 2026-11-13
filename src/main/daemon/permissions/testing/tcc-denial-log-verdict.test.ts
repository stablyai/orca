import { describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { parseTccLogVerdict, readTccLogVerdict } from '../tcc-denial-log-verdict'

// Real tccd lines from a macOS 27.2 VM (usernames redacted), as `log show --style ndjson` emits them.
const HELPER =
  '/Users/user/Library/Application Support/orca/daemon-host/macos/terminal-host-57202dec6187e819396a5a0ab07c2932bf5a00fe/app.noindex/Orca Terminal Host.app/Contents/MacOS/orca-terminal-host'
const TCCD = '/System/Library/PrivateFrameworks/TCC.framework/Support/tccd'
const SANDBOXD = '/usr/libexec/sandboxd'
const DENIED_AT_MS = Date.UTC(2026, 10, 13, 20, 24, 30)

function line(timestamp: string, image: string, pid: number, eventMessage: string): string {
  return JSON.stringify({
    timestamp: `2026-11-13 ${timestamp}+0000`,
    processImagePath: image,
    processID: pid,
    subsystem: 'com.apple.TCC',
    eventMessage
  })
}

const HELPER_DOWNLOADS_REFUSED = [
  line(
    '20:24:20.457760',
    SANDBOXD,
    153,
    'SEND: 0/7 synchronous to com.apple.tccd: request: msgID=153.1126, function=TCCAccessRequest, service=kTCCServiceSystemPolicyDownloadsFolder,'
  ),
  line(
    '20:24:20.458006',
    TCCD,
    350,
    'AUTHREQ_CTX: msgID=153.1126, function=TCCAccessRequest, service=kTCCServiceSystemPolicyDownloadsFolder, preflight=no, query=1, client_dict=(null), daemon_dict=<private>'
  ),
  line(
    '20:24:20.458018',
    TCCD,
    350,
    `AUTHREQ_ATTRIBUTION: msgID=153.1126, attribution={accessing={TCCDProcess: identifier=com.stablyai.orca, pid=1206, auid=501, euid=501, binary_path=${HELPER}}, requesting={TCCDProcess: identifier=com.apple.sandboxd, pid=153, auid=0, euid=0, binary_path=/usr/libexec/sandboxd}, },`
  ),
  line(
    '20:24:49.917729',
    TCCD,
    350,
    'AUTHREQ_RESULT: msgID=153.1126, authValue=0, authReason=2, authVersion=1, desired_auth=0, error=(null),'
  )
]

// The main app's own refusal: same identifier, different pid; it must not count for the helper.
const APP_DOCUMENTS_REFUSED = [
  line(
    '20:14:22.730560',
    TCCD,
    350,
    'AUTHREQ_ATTRIBUTION: msgID=153.1044, attribution={responsible={TCCDProcess: identifier=com.stablyai.orca, pid=902, auid=501, euid=501, responsible_path=/Applications/Orca.app/Contents/MacOS/Orca, binary_path=/Applications/Orca.app/Contents/MacOS/Orca}, accessing={TCCDProcess: identifier=com.stablyai.orca.helper, pid=1959, auid=501, euid=501, binary_path=/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper}, requesting={TCCDProcess: identifier=com.apple.sandboxd, pid=153, auid=0, euid=0, binary_path=/usr/libexec/sandboxd}, },'
  ),
  line(
    '20:14:22.738046',
    TCCD,
    350,
    'AUTHREQ_RESULT: msgID=153.1044, authValue=0, authReason=2, authVersion=1, desired_auth=0, error=(null),'
  )
]

const HELPER_DOCUMENTS_ALLOWED = [
  line(
    '20:16:05.882048',
    SANDBOXD,
    153,
    'SEND: 0/7 synchronous to com.apple.tccd: request: msgID=153.1060, function=TCCAccessRequest, service=kTCCServiceSystemPolicyDocumentsFolder,'
  ),
  line(
    '20:16:05.882368',
    TCCD,
    350,
    `AUTHREQ_ATTRIBUTION: msgID=153.1060, attribution={accessing={TCCDProcess: identifier=com.stablyai.orca, pid=1206, auid=501, euid=501, binary_path=${HELPER}}, requesting={TCCDProcess: identifier=com.apple.sandboxd, pid=153, auid=0, euid=0, binary_path=/usr/libexec/sandboxd}, },`
  ),
  line(
    '20:16:05.891091',
    TCCD,
    350,
    'AUTHREQ_RESULT: msgID=153.1060, authValue=2, authReason=2, authVersion=1, desired_auth=0, error=(null),'
  )
]

// Kernel sandbox report in the shape macOS 27 prints (seen for other processes on a real Mac).
const KERNEL_DENY = JSON.stringify({
  timestamp: '2026-11-13 20:24:20.457000+0000',
  processImagePath: '/kernel',
  processID: 0,
  subsystem: '',
  eventMessage:
    '1 duplicate report for Sandbox: orca-terminal-host(1206) deny(1) file-read-data /Users/user/Downloads'
})

const SUBJECT = {
  helperPid: 1206,
  helperPath: HELPER,
  appId: 'com.stablyai.orca',
  cwdClass: 'downloads' as const
}

function ndjson(lines: string[]): string {
  return ['Filtering the log data using "subsystem == \\"com.apple.TCC\\""', ...lines].join('\n')
}

describe('parseTccLogVerdict', () => {
  it("reads the helper's own refused request and ignores the app's", () => {
    const verdict = parseTccLogVerdict(
      ndjson([...APP_DOCUMENTS_REFUSED, ...HELPER_DOWNLOADS_REFUSED, KERNEL_DENY]),
      SUBJECT,
      'ok'
    )

    expect(verdict).toMatchObject({
      logAccess: 'ok',
      tccdAsked: 'yes',
      authValue: 'denied',
      authReason: '2',
      service: 'downloads',
      requirementFailure: 'no',
      kernelDeny: 'yes'
    })
  })

  it('reports no tccd request when only other processes asked', () => {
    expect(parseTccLogVerdict(ndjson(APP_DOCUMENTS_REFUSED), SUBJECT, 'ok')).toMatchObject({
      tccdAsked: 'no',
      authValue: 'none',
      authReason: 'none',
      service: 'none',
      kernelDeny: 'no'
    })
  })

  it('prefers the decision for the denied folder class over a later one', () => {
    const verdict = parseTccLogVerdict(
      ndjson([...HELPER_DOWNLOADS_REFUSED, ...HELPER_DOCUMENTS_ALLOWED]),
      SUBJECT,
      'ok'
    )
    expect(verdict).toMatchObject({ service: 'downloads', authValue: 'denied' })

    const documents = parseTccLogVerdict(
      ndjson([...HELPER_DOWNLOADS_REFUSED, ...HELPER_DOCUMENTS_ALLOWED]),
      { ...SUBJECT, cwdClass: 'documents' },
      'ok'
    )
    expect(documents).toMatchObject({ service: 'documents', authValue: 'allowed' })
  })

  it('flags a failed stored requirement but not the routine "anchor apple" check', () => {
    const routine = line(
      '20:06:45.144194',
      TCCD,
      157,
      '-[TCCDAccessIdentity matchesCodeRequirement:]: SecStaticCodeCheckValidity() static code (0x7cf9194300) from com.stablyai.orca : anchor apple; status: -67050'
    )
    expect(parseTccLogVerdict(ndjson([routine]), SUBJECT, 'ok').requirementFailure).toBe('no')

    const failed = line(
      '20:06:46.000000',
      TCCD,
      157,
      'Failed to match existing code requirement for subject com.stablyai.orca and service kTCCServiceSystemPolicyDownloadsFolder'
    )
    // The app and its hosts share the identifier, so this cannot be blamed on this helper.
    expect(parseTccLogVerdict(ndjson([failed]), SUBJECT, 'ok').requirementFailure).toBe(
      'uncorrelated'
    )

    const helperCheck = line(
      '20:06:47.000000',
      TCCD,
      157,
      `-[TCCDAccessIdentity matchesCodeRequirement:]: SecStaticCodeCheckValidity() static code (0x7cf9194300) from ${HELPER} : identifier "com.stablyai.orca" and anchor apple generic; status: -67050`
    )
    expect(
      parseTccLogVerdict(ndjson([failed, helperCheck]), SUBJECT, 'ok').requirementFailure
    ).toBe('yes')
  })

  it('ignores requirement failures for other apps', () => {
    const other = line(
      '20:06:46.000000',
      TCCD,
      157,
      'Failed to match existing code requirement for subject org.example.other and service kTCCServiceSystemPolicyDownloadsFolder'
    )
    expect(parseTccLogVerdict(ndjson([other]), SUBJECT, 'ok')).toMatchObject({
      requirementFailure: 'no'
    })
  })

  it('does not credit an earlier helper on the same copy path to this one', () => {
    const earlierHelper = HELPER_DOWNLOADS_REFUSED.map((entry) =>
      entry.replace('pid=1206', 'pid=1100')
    )
    expect(parseTccLogVerdict(ndjson(earlierHelper), SUBJECT, 'ok')).toMatchObject({
      tccdAsked: 'no',
      authValue: 'none'
    })
  })

  it('leaves tccd_asked unknown when the log was unreadable or cut short', () => {
    expect(parseTccLogVerdict('', SUBJECT, 'denied').tccdAsked).toBe('unknown')
    expect(parseTccLogVerdict(ndjson(APP_DOCUMENTS_REFUSED), SUBJECT, 'truncated').tccdAsked).toBe(
      'unknown'
    )
  })
})

describe('readTccLogVerdict', () => {
  it('asks for Info records in a window that ends at the denial', async () => {
    let args: readonly string[] = []
    await readTccLogVerdict(DENIED_AT_MS, SUBJECT, async (spec) => {
      args = spec.args ?? []
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
    })
    expect(args).toEqual([
      'show',
      '--info',
      '--style',
      'ndjson',
      '--start',
      '2026-11-13 20:24:00+0000',
      '--end',
      '2026-11-13 20:24:32+0000',
      '--predicate',
      '(subsystem == "com.apple.TCC") OR (sender == "Sandbox")'
    ])
  })

  it('keeps what a timed-out log printed and reports the timeout', async () => {
    const verdict = await readTccLogVerdict(DENIED_AT_MS, SUBJECT, async () => ({
      code: null,
      signal: 'SIGTERM',
      stdout: ndjson(HELPER_DOWNLOADS_REFUSED),
      stderr: '',
      timedOut: true
    }))
    expect(verdict).toMatchObject({ logAccess: 'timeout', authValue: 'denied' })
  })

  it.skipIf(process.platform === 'win32')(
    'kills a hung log reader at its deadline',
    async () => {
      // Same spec, but a child that never exits on its own.
      const verdict = await readTccLogVerdict(DENIED_AT_MS, SUBJECT, (spec) =>
        runProcess({ ...spec, program: '/bin/sleep', args: ['60'] })
      )
      expect(verdict.logAccess).toBe('timeout')
    },
    15_000
  )

  it('swallows a spawn failure', async () => {
    const verdict = await readTccLogVerdict(DENIED_AT_MS, SUBJECT, async () => {
      throw new Error('spawn ENOENT')
    })
    expect(verdict).toMatchObject({ logAccess: 'error', tccdAsked: 'unknown' })
  })
})
