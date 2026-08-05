/**
 * Runs the CURRENT build's DaemonPtyAdapter against a REAL daemon built from
 * every still-supported previous release, plus the working tree as a control.
 *
 * Daemons survive app updates, so this pairing — new adapter, old daemon — is
 * what every pre-existing pane hits after an update, and nothing else in the
 * suite exercises it: the sibling adoption tests construct the current
 * DaemonServer wearing an old protocol number, which cannot reproduce a
 * daemon-side behavior change. #11789 shipped a total reattach failure through
 * exactly that gap.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { SessionNotFoundError } from './daemon-errors'
import {
  PREVIOUS_DAEMON_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION
} from './daemon-protocol-version'
import { LEGACY_DAEMON_RELEASES } from './legacy-daemon-release-refs'
import {
  bootDaemon,
  buildDaemonEntryFromRef,
  buildDaemonEntryFromWorkingTree
} from './legacy-daemon-release-runtime'
import type { BootedDaemon } from './legacy-daemon-release-runtime'
import type { PtySpawnResult } from '../providers/pty-spawn-result'

const CASE_TIMEOUT_MS = 120_000
const MARKER_TIMEOUT_MS = 30_000
const SETTLE_TIMEOUT_MS = 15_000
const MAX_CAPTURE_CHARS = 64 * 1024

// Why the working tree too: it proves the assertions below can be satisfied at
// all, so a legacy failure reads as a compatibility break rather than a broken
// harness. `ref: null` selects the build under test instead of a git ref.
const REATTACH_CASES = [
  ...LEGACY_DAEMON_RELEASES.map((release) => ({
    protocolVersion: release.protocolVersion,
    ref: release.ref
  })),
  { protocolVersion: PROTOCOL_VERSION, ref: null }
]

function identity(value: unknown): unknown {
  return value
}

async function waitUntil(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  failure: () => string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) {
      return
    }
    if (Date.now() >= deadline) {
      throw new Error(failure())
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('cross-protocol daemon reattach coverage', () => {
  it('declares a release for every still-supported previous protocol', () => {
    expect(LEGACY_DAEMON_RELEASES.map((release) => release.protocolVersion)).toEqual([
      ...PREVIOUS_DAEMON_PROTOCOL_VERSIONS
    ])
  })

  // Why: bumping PROTOCOL_VERSION without appending the outgoing version leaves
  // the build users are still running untested — the #11789 shape exactly.
  it('requires a protocol bump to extend the previous-version list', () => {
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS.at(-1)).toBe(PROTOCOL_VERSION - 1)
  })
})

// Why POSIX-only: the fixture drives the PTY with a shell command and reads the
// daemon's child processes via ps; neither has a Windows equivalent here.
describe.skipIf(process.platform === 'win32').each(REATTACH_CASES)(
  'current build against a protocol $protocolVersion daemon',
  ({ protocolVersion, ref }) => {
    const marker = `orca-reattach-${protocolVersion}`
    const sessionId = `cross-protocol-pane-${protocolVersion}`
    const missingSessionId = `cross-protocol-missing-${protocolVersion}`
    let runtimeDir = ''
    let daemon: BootedDaemon | null = null
    let livePane: PtySpawnResult | null = null
    let childPidsWithLivePane: Set<number> | null = null

    const createAdapter = (): DaemonPtyAdapter => {
      if (!daemon) {
        throw new Error(`protocol ${protocolVersion} daemon is not running`)
      }
      return new DaemonPtyAdapter({
        socketPath: daemon.socketPath,
        tokenPath: daemon.tokenPath,
        protocolVersion
      })
    }

    /** The pane as it existed before the update: created by whatever app build
     *  shipped with this daemon, then left running across the restart. It also
     *  has to exist before anything else, or the daemon retires as unadopted. */
    const createLivePane = async (): Promise<PtySpawnResult> => {
      const creator = createAdapter()
      try {
        const created = await creator.spawn({ sessionId, cols: 80, rows: 24, cwd: runtimeDir })
        let output = ''
        const stopListening = creator.onData((payload) => {
          if (payload.id === sessionId) {
            output = `${output}${payload.data}`.slice(-MAX_CAPTURE_CHARS)
          }
        })
        try {
          await waitUntil(
            () => {
              // Re-sent because a shell still sourcing its rc files can drop
              // the first line; extra copies only add ignored output.
              creator.write(sessionId, `printf 'ok-%s\\n' ${marker}\r`)
              return output.includes(`ok-${marker}`)
            },
            MARKER_TIMEOUT_MS,
            () => `protocol ${protocolVersion} shell never produced ok-${marker}: ${output}`
          )
        } finally {
          stopListening()
        }
        return created
      } finally {
        creator.dispose()
      }
    }

    const attachOnlyMissingSession = async (adapter: DaemonPtyAdapter): Promise<void> => {
      const failure: unknown = await adapter
        .spawn({
          sessionId: missingSessionId,
          cols: 120,
          rows: 40,
          cwd: runtimeDir,
          attachOnly: true,
          command: 'must-not-run'
        })
        .then((result) => {
          throw new Error(`attach-only created session ${result.id} instead of failing`)
        }, identity)
      // Why the message and not just the class: a native v31 rejection crosses
      // the wire as a plain DaemonProtocolError, and the mount path classifies
      // it by message (isPtyAlreadyGoneError in ipc/pty.ts) to retire the owner
      // and respawn. #11789 failed here — terminal_pane_owner_unknown matched
      // nothing, so the pane surfaced a raw code instead.
      if (!(failure instanceof Error)) {
        throw new Error(`attach-only rejected with a non-error value: ${String(failure)}`)
      }
      expect(failure.message).toMatch(/Session not found/i)
      if (protocolVersion < STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION) {
        // The emulation raises it in-process, so the class survives too.
        expect(failure).toBeInstanceOf(SessionNotFoundError)
      }
    }

    /** Pre-31 daemons have no attach-only, so the adapter emulates it by creating
     *  and then killing — and the kill returns before the daemon retires the
     *  record, hence a bounded settle rather than a single sample. */
    const expectNoResidue = async (adapter: DaemonPtyAdapter): Promise<void> => {
      let sessionIds: string[] = []
      await waitUntil(
        async () => {
          sessionIds = (await adapter.listSessions()).map((session) => session.sessionId)
          return !sessionIds.includes(missingSessionId)
        },
        SETTLE_TIMEOUT_MS,
        () => `protocol ${protocolVersion} kept an orphan session: ${sessionIds.join(', ')}`
      )
      expect(sessionIds).toEqual([sessionId])

      let childPids: Set<number> | null = null
      await waitUntil(
        () => {
          childPids = daemon?.childPids() ?? null
          return childPids === null || childPids.size === (childPidsWithLivePane?.size ?? 0)
        },
        SETTLE_TIMEOUT_MS,
        () => {
          const pids: number[] = [...(childPids ?? [])]
          return `protocol ${protocolVersion} left an orphan process: ${pids.join(', ')}`
        }
      )
      expect(childPids).toEqual(childPidsWithLivePane)
    }

    beforeAll(async () => {
      const build = ref ? await buildDaemonEntryFromRef(ref) : null
      // A manifest entry naming the wrong ref would silently retest some other
      // protocol, so trust the version read out of that ref's own source.
      expect(build?.protocolVersion ?? PROTOCOL_VERSION).toBe(protocolVersion)
      runtimeDir = mkdtempSync(join(tmpdir(), `cross-protocol-daemon-${protocolVersion}-`))
      daemon = await bootDaemon({
        entryPath: build ? build.entryPath : await buildDaemonEntryFromWorkingTree(),
        runtimeDir
      })
      livePane = await createLivePane()
      childPidsWithLivePane = daemon.childPids()
    }, CASE_TIMEOUT_MS)

    afterAll(async () => {
      await daemon?.stop()
      daemon = null
      if (runtimeDir) {
        rmSync(runtimeDir, { recursive: true, force: true })
      }
    })

    it(
      'adopts the live session instead of replacing it',
      async () => {
        const adapter = createAdapter()
        try {
          const attached = await adapter.spawn({
            sessionId,
            cols: 120,
            rows: 40,
            attachOnly: true,
            command: 'must-not-run'
          })

          expect(attached.id).toBe(sessionId)
          expect(attached.isReattach).toBe(true)
          // The load-bearing one: a replacement shell would be a different
          // process, which is what "looks like success but lost everything"
          // means at the OS level.
          expect(attached.pid).toBe(livePane?.pid)
          expect(attached.snapshot).toContain(`ok-${marker}`)

          const sessions = await adapter.listSessions()
          expect(sessions.map((session) => session.sessionId)).toEqual([sessionId])
        } finally {
          adapter.dispose()
        }
      },
      CASE_TIMEOUT_MS
    )

    it(
      'rejects a missing session without leaving an orphan behind',
      async () => {
        const adapter = createAdapter()
        try {
          await attachOnlyMissingSession(adapter)
          await expectNoResidue(adapter)

          // A kill aimed at the wrong id would satisfy everything above.
          const survivor = (await adapter.listSessions()).find(
            (session) => session.sessionId === sessionId
          )
          expect(survivor?.isAlive).toBe(true)
          expect(survivor?.pid).toBe(livePane?.pid)
        } finally {
          adapter.dispose()
        }
      },
      CASE_TIMEOUT_MS
    )
  }
)
