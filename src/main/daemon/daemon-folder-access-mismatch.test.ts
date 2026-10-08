import { beforeEach, describe, expect, it, vi } from 'vitest'
import { validate } from '../telemetry/validator'

const { trackMock, probeMock } = vi.hoisted(() => ({ trackMock: vi.fn(), probeMock: vi.fn() }))
vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('./daemon-folder-access-probe', () => ({
  probeFolderAccessForFreshDaemon: probeMock
}))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  homedir: () => '/Users/alice'
}))

import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import {
  clearDaemonFolderAccessMismatch,
  getDaemonFolderAccessMismatch,
  getDaemonFolderAccessTarget,
  recordDaemonFolderAccessMismatch,
  refreshDaemonFolderAccessProbe,
  resetDaemonFolderAccessMismatchForTests
} from './daemon-folder-access-mismatch'

const DAEMON: DaemonEndpointIdentity = { pid: 1530, startedAtMs: 1_700_000, launchNonce: 'n1' }
const RESTARTED: DaemonEndpointIdentity = { pid: 1610, startedAtMs: 1_700_900, launchNonce: 'n2' }
const DOCUMENTS = '/Users/alice/Documents/repo'

beforeEach(() => {
  resetDaemonFolderAccessMismatchForTests()
  trackMock.mockReset()
  probeMock.mockReset().mockResolvedValue('unknown')
  vi.useRealTimers()
})

/** Where an unawaited probe's result lands. */
async function settleProbe(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/** The spawn path records without probing, so every verdict here comes from a refresh. */
async function recordAndProbe(
  identity: DaemonEndpointIdentity,
  cwd: string = DOCUMENTS
): Promise<void> {
  recordDaemonFolderAccessMismatch(identity, cwd)
  await refreshDaemonFolderAccessProbe(identity)
}

describe('daemon folder access mismatch evidence', () => {
  it('has nothing until a spawn records one', () => {
    expect(getDaemonFolderAccessMismatch(DAEMON)).toBeNull()
  })

  it('classifies the recorded cwd and keeps only the latest entry', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    expect(getDaemonFolderAccessMismatch(DAEMON)?.cwdClass).toBe('documents')

    recordDaemonFolderAccessMismatch(DAEMON, '/Users/alice/Desktop/other')
    expect(getDaemonFolderAccessMismatch(DAEMON)?.cwdClass).toBe('desktop')
  })

  it('clears when the same daemon later reads a cwd of the same folder class', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    clearDaemonFolderAccessMismatch(DAEMON, '/Users/alice/Documents/other-repo')
    expect(getDaemonFolderAccessMismatch(DAEMON)).toBeNull()
  })

  it('keeps the evidence when the same daemon reads a folder of another class', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    clearDaemonFolderAccessMismatch(DAEMON, '/Users/alice/code/repo')
    expect(getDaemonFolderAccessMismatch(DAEMON)).not.toBeNull()
  })

  it('ignores a clear from a different daemon', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    clearDaemonFolderAccessMismatch(RESTARTED, DOCUMENTS)
    expect(getDaemonFolderAccessMismatch(DAEMON)).not.toBeNull()
  })

  // This is the whole restart remedy: a new daemon has a new identity, so the poll goes quiet
  // without anyone probing the folder again.
  it('returns null once the daemon that earned it has been replaced', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    expect(getDaemonFolderAccessMismatch(RESTARTED)).toBeNull()
  })

  it('returns null when there is no current daemon identity', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    expect(getDaemonFolderAccessMismatch(null)).toBeNull()
  })

  it('records nothing for a daemon that has no identity yet', () => {
    recordDaemonFolderAccessMismatch(null, DOCUMENTS)
    expect(getDaemonFolderAccessMismatch(DAEMON)).toBeNull()
  })

  it('gives one daemon a stable scope and two daemons different scopes', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    const first = getDaemonFolderAccessMismatch(DAEMON)?.daemonScope
    expect(getDaemonFolderAccessMismatch(DAEMON)?.daemonScope).toBe(first)

    recordDaemonFolderAccessMismatch(RESTARTED, DOCUMENTS)
    expect(getDaemonFolderAccessMismatch(RESTARTED)?.daemonScope).not.toBe(first)
  })

  // The notice names a folder, so a second class under one daemon is a new notice, not the same
  // one with a new word in it.
  it('mints a new scope when the same daemon is denied a second folder class', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    const documents = getDaemonFolderAccessMismatch(DAEMON)?.daemonScope

    recordDaemonFolderAccessMismatch(DAEMON, '/Users/alice/Desktop/other')

    expect(getDaemonFolderAccessMismatch(DAEMON)?.daemonScope).not.toBe(documents)
  })

  it('gives one daemon the same scope for every cwd of one folder class', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    const first = getDaemonFolderAccessMismatch(DAEMON)?.daemonScope

    recordDaemonFolderAccessMismatch(DAEMON, '/Users/alice/Documents/other-repo')

    expect(getDaemonFolderAccessMismatch(DAEMON)?.daemonScope).toBe(first)
  })

  it('keeps every path fragment and the folder class out of the scope', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    const scope = getDaemonFolderAccessMismatch(DAEMON)?.daemonScope ?? ''
    expect(scope).toMatch(/^[0-9a-f]{16}$/)
    for (const fragment of ['alice', 'Documents', 'documents', 'repo', 'Users']) {
      expect(scope).not.toContain(fragment)
    }
  })
})

describe('freshDaemonAccess', () => {
  it('starts unanswered, and the spawn path forks no child to answer it', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)

    expect(getDaemonFolderAccessMismatch(DAEMON)?.freshDaemonAccess).toBe('unknown')
    expect(probeMock).not.toHaveBeenCalled()
  })

  it('probes the folder the spawn was denied on', async () => {
    await recordAndProbe(DAEMON)

    expect(probeMock).toHaveBeenCalledWith(DOCUMENTS)
  })

  it.each([
    ['ok', 'allowed'],
    ['denied', 'denied'],
    ['missing', 'unknown'],
    ['other', 'unknown'],
    ['unknown', 'unknown']
  ])('maps a %s probe to %s', async (outcome, expected) => {
    probeMock.mockResolvedValue(outcome)
    await recordAndProbe(DAEMON)

    expect(getDaemonFolderAccessMismatch(DAEMON)?.freshDaemonAccess).toBe(expected)
  })

  it('drops a probe whose entry was replaced while the child ran', async () => {
    let release: (value: string) => void = () => {}
    probeMock.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        release = resolve
      })
    )
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    void refreshDaemonFolderAccessProbe(DAEMON)

    probeMock.mockResolvedValue('denied')
    recordDaemonFolderAccessMismatch(DAEMON, '/Users/alice/Desktop/other')
    const forced = refreshDaemonFolderAccessProbe(DAEMON, { force: true })
    release('ok')
    await forced

    const notice = getDaemonFolderAccessMismatch(DAEMON)
    expect(notice?.cwdClass).toBe('desktop')
    expect(notice?.freshDaemonAccess).toBe('denied')
  })

  it('survives a probe that rejects', async () => {
    probeMock.mockRejectedValue(new Error('spawn failed'))
    await recordAndProbe(DAEMON)

    expect(getDaemonFolderAccessMismatch(DAEMON)?.freshDaemonAccess).toBe('unknown')
  })
})

describe('refreshDaemonFolderAccessProbe', () => {
  it('re-probes a denial so step one can complete itself', async () => {
    probeMock.mockResolvedValue('denied')
    await recordAndProbe(DAEMON)
    expect(getDaemonFolderAccessMismatch(DAEMON)?.freshDaemonAccess).toBe('denied')

    vi.setSystemTime(Date.now() + 6_000)
    probeMock.mockResolvedValue('ok')
    await refreshDaemonFolderAccessProbe(DAEMON)

    expect(getDaemonFolderAccessMismatch(DAEMON)?.freshDaemonAccess).toBe('allowed')
  })

  it('reuses a probe younger than the refresh interval', async () => {
    probeMock.mockResolvedValue('denied')
    await recordAndProbe(DAEMON)
    expect(probeMock).toHaveBeenCalledTimes(1)

    await refreshDaemonFolderAccessProbe(DAEMON)

    expect(probeMock).toHaveBeenCalledTimes(1)
  })

  it('treats a settled true as final', async () => {
    probeMock.mockResolvedValue('ok')
    await recordAndProbe(DAEMON)
    vi.setSystemTime(Date.now() + 60_000)

    await refreshDaemonFolderAccessProbe(DAEMON)

    expect(probeMock).toHaveBeenCalledTimes(1)
  })

  it('probes again on a forced refresh even after a settled allowed', async () => {
    probeMock.mockResolvedValue('ok')
    await recordAndProbe(DAEMON)

    await refreshDaemonFolderAccessProbe(DAEMON, { force: true })

    expect(probeMock).toHaveBeenCalledTimes(2)
  })

  it('re-probes an unanswered entry once the interval has passed', async () => {
    probeMock.mockResolvedValue('other')
    await recordAndProbe(DAEMON)
    vi.setSystemTime(Date.now() + 6_000)

    await refreshDaemonFolderAccessProbe(DAEMON)

    expect(probeMock).toHaveBeenCalledTimes(2)
  })

  it('does nothing for a daemon the evidence does not belong to', async () => {
    probeMock.mockResolvedValue('denied')
    await recordAndProbe(DAEMON)
    vi.setSystemTime(Date.now() + 6_000)

    await refreshDaemonFolderAccessProbe(RESTARTED)
    await refreshDaemonFolderAccessProbe(null)

    expect(probeMock).toHaveBeenCalledTimes(1)
  })

  it('joins an in-flight probe instead of starting a second child', async () => {
    let release: (value: string) => void = () => {}
    probeMock.mockReturnValue(
      new Promise<string>((resolve) => {
        release = resolve
      })
    )
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    const first = refreshDaemonFolderAccessProbe(DAEMON)
    const joined = refreshDaemonFolderAccessProbe(DAEMON)
    release('ok')
    await Promise.all([first, joined])

    expect(probeMock).toHaveBeenCalledTimes(1)
    expect(getDaemonFolderAccessMismatch(DAEMON)?.freshDaemonAccess).toBe('allowed')
  })

  // The reset's caller needs a verdict from after the reset, and the interval is what would
  // otherwise hand it the pre-reset one.
  it('probes again inside the refresh interval when forced', async () => {
    probeMock.mockResolvedValue('denied')
    await recordAndProbe(DAEMON)
    probeMock.mockResolvedValue('ok')

    await refreshDaemonFolderAccessProbe(DAEMON, { force: true })

    expect(probeMock).toHaveBeenCalledTimes(2)
    expect(getDaemonFolderAccessMismatch(DAEMON)?.freshDaemonAccess).toBe('allowed')
  })

  // A probe that started before the reset would otherwise win the race and discard the forced
  // one's write, reporting the state the reset was meant to change.
  it('waits for an older in-flight probe and still lands its own verdict', async () => {
    const releases: ((value: string) => void)[] = []
    probeMock.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          releases.push(resolve)
        })
    )
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    void refreshDaemonFolderAccessProbe(DAEMON)

    const forced = refreshDaemonFolderAccessProbe(DAEMON, { force: true })
    releases[0]('denied')
    await settleProbe()
    releases[1]('ok')
    await forced

    expect(probeMock).toHaveBeenCalledTimes(2)
    expect(getDaemonFolderAccessMismatch(DAEMON)?.freshDaemonAccess).toBe('allowed')
  })
})

describe('getDaemonFolderAccessTarget', () => {
  it('hands the remedy the folder the evidence is about', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)

    expect(getDaemonFolderAccessTarget(DAEMON)).toEqual({
      canonicalPath: DOCUMENTS,
      cwdClass: 'documents'
    })
  })

  it('has no target for another daemon, no daemon, or no evidence', () => {
    expect(getDaemonFolderAccessTarget(DAEMON)).toBeNull()

    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)

    expect(getDaemonFolderAccessTarget(RESTARTED)).toBeNull()
    expect(getDaemonFolderAccessTarget(null)).toBeNull()
  })

  // Reading evidence is not showing it: the renderer owns the `shown` event.
  it('emits nothing, and neither does reading the notice', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    trackMock.mockReset()

    getDaemonFolderAccessTarget(DAEMON)
    getDaemonFolderAccessMismatch(DAEMON)
    getDaemonFolderAccessMismatch(DAEMON)

    expect(trackMock).not.toHaveBeenCalled()
  })
})

describe('restart outcome', () => {
  it('counts a replacement daemon that can read the folder as fixed', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    trackMock.mockReset()

    clearDaemonFolderAccessMismatch(RESTARTED, '/Users/alice/Documents/other')

    expect(trackMock).toHaveBeenCalledWith('daemon_folder_access_notice', {
      action: 'restart_outcome_fixed',
      cwd_class: 'documents'
    })
    expect(validate('daemon_folder_access_notice', trackMock.mock.calls[0][1]).ok).toBe(true)
  })

  it('counts a replacement daemon denied the same folder as still denied', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    trackMock.mockReset()

    recordDaemonFolderAccessMismatch(RESTARTED, DOCUMENTS)

    expect(trackMock).toHaveBeenCalledWith('daemon_folder_access_notice', {
      action: 'restart_outcome_still_denied',
      cwd_class: 'documents'
    })
    expect(validate('daemon_folder_access_notice', trackMock.mock.calls[0][1]).ok).toBe(true)
  })

  it('counts one outcome per restart, not one per spawn', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    trackMock.mockReset()

    clearDaemonFolderAccessMismatch(RESTARTED, DOCUMENTS)
    clearDaemonFolderAccessMismatch(RESTARTED, DOCUMENTS)

    const outcomes = trackMock.mock.calls.filter(([, props]) =>
      String(props.action).startsWith('restart_outcome_')
    )
    expect(outcomes).toHaveLength(1)
  })

  // The same daemon reading back is a TCC grant landing mid-session, not a restart's verdict.
  it('says nothing when the daemon that was denied reads the folder itself', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    trackMock.mockReset()

    clearDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)

    expect(trackMock).not.toHaveBeenCalled()
  })

  // A readable ~/code after a Documents denial says nothing about Documents.
  it('says nothing for a spawn in another folder class', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    trackMock.mockReset()

    clearDaemonFolderAccessMismatch(RESTARTED, '/Users/alice/code/repo')
    recordDaemonFolderAccessMismatch(RESTARTED, '/Users/alice/Desktop/x')

    const outcomes = trackMock.mock.calls.filter(([, props]) =>
      String(props.action).startsWith('restart_outcome_')
    )
    expect(outcomes).toHaveLength(0)
  })

  it('says nothing when no denial preceded the spawn', () => {
    clearDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    expect(trackMock).not.toHaveBeenCalled()
  })

  // The denial resolved itself before any restart, so the next daemon's denial is its own story.
  it('says nothing about a denial the same daemon had already read back', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    clearDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    trackMock.mockReset()

    recordDaemonFolderAccessMismatch(RESTARTED, DOCUMENTS)

    expect(trackMock).not.toHaveBeenCalled()
  })

  it('still records the replacement denial when the telemetry client throws', () => {
    recordDaemonFolderAccessMismatch(DAEMON, DOCUMENTS)
    trackMock.mockImplementationOnce(() => {
      throw new Error('posthog exploded')
    })

    recordDaemonFolderAccessMismatch(RESTARTED, DOCUMENTS)

    expect(getDaemonFolderAccessMismatch(RESTARTED)?.cwdClass).toBe('documents')
  })
})
