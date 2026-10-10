import { describe, expect, it } from 'vitest'
import {
  buildPaneProcessFingerprint,
  type PaneFingerprintRow
} from './posix-pane-foreground-fingerprint'

const SHELL = 4242
const AGENT = 4300
const OTHER_PANE = 9000

type Row = PaneFingerprintRow

const shell = (over: Partial<Row> = {}): Row => ({
  pid: SHELL,
  ppid: 1,
  pgid: SHELL,
  tpgid: AGENT,
  stat: 'Ss',
  startTime: 'Thu Sep 3 16:02:01 2026',
  ...over
})
const agent = (over: Partial<Row> = {}): Row => ({
  pid: AGENT,
  ppid: SHELL,
  pgid: AGENT,
  tpgid: AGENT,
  stat: 'S+',
  startTime: 'Thu Sep 3 16:02:05 2026',
  ...over
})
const child = (pid: number, ppid: number, over: Partial<Row> = {}): Row => ({
  pid,
  ppid,
  pgid: AGENT,
  tpgid: AGENT,
  stat: 'S+',
  startTime: `Thu Sep 3 16:03:${String(pid % 60).padStart(2, '0')} 2026`,
  ...over
})
const foreign = (): Row => ({
  pid: OTHER_PANE,
  ppid: 1,
  pgid: OTHER_PANE,
  tpgid: OTHER_PANE,
  stat: 'Ss+',
  startTime: 'Thu Sep 3 12:00:00 2026'
})

const fp = (rows: Row[]): Promise<string | null> =>
  buildPaneProcessFingerprint(rows, SHELL, { platform: 'darwin' })

describe('buildPaneProcessFingerprint', () => {
  const baseline = [foreign(), shell(), agent()]

  it('is stable across captures that differ only in scheduler state, row order, and foreign panes', async () => {
    const a = await fp(baseline)
    expect(a).not.toBeNull()
    // R vs S: a working agent flips this every tick and it says nothing about the pane.
    expect(await fp([agent({ stat: 'R+' }), shell({ stat: 'Ss' }), foreign()])).toBe(a)
    // The shell going idle-vs-runnable, or a foreign pane starting/exiting, is not our business.
    expect(await fp([shell({ stat: 'Rs' }), agent()])).toBe(a)
    // lstart padding differs between column sets; both must stamp identically.
    expect(await fp([shell({ startTime: 'Thu Sep  3 16:02:01 2026' }), agent()])).toBe(a)
  })

  describe('escalates (fingerprint changes) on every completion-relevant transition', () => {
    it('agent exit: the recognized pid vanishes from the subtree', async () => {
      const before = await fp(baseline)
      expect(await fp([foreign(), shell({ tpgid: SHELL, stat: 'Ss+' })])).not.toBe(before)
    })

    it('exit-and-replace: the same pid is reused by a new process with a new start time', async () => {
      const before = await fp(baseline)
      expect(await fp([shell(), agent({ startTime: 'Thu Sep 3 16:09:00 2026' })])).not.toBe(before)
    })

    it('Ctrl-Z: the agent stops and the shell takes the terminal back', async () => {
      const before = await fp(baseline)
      expect(await fp([shell({ tpgid: SHELL, stat: 'Ss+' }), agent({ stat: 'T' })])).not.toBe(
        before
      )
    })

    it('bg: the stopped job resumes in the background, foreground stays with the shell', async () => {
      const stopped = await fp([shell({ tpgid: SHELL, stat: 'Ss+' }), agent({ stat: 'T' })])
      const backgrounded = await fp([shell({ tpgid: SHELL, stat: 'Ss+' }), agent({ stat: 'S' })])
      expect(backgrounded).not.toBe(stopped)
      expect(backgrounded).not.toBe(await fp(baseline))
    })

    it('child churn: a subprocess appearing or disappearing under the agent', async () => {
      const before = await fp(baseline)
      const withChild = await fp([shell(), agent(), child(4310, AGENT)])
      expect(withChild).not.toBe(before)
      expect(await fp([shell(), agent(), child(4310, AGENT), child(4311, 4310)])).not.toBe(
        withChild
      )
      // A child exec'ing away from the group (setsid / disown) is also a change.
      expect(await fp([shell(), agent(), child(4310, AGENT, { pgid: 4310 })])).not.toBe(withChild)
    })

    it('shell replaced: same pid, different start time', async () => {
      const before = await fp(baseline)
      expect(await fp([shell({ startTime: 'Thu Sep 3 17:00:00 2026' }), agent()])).not.toBe(before)
    })
  })

  describe('refuses to fingerprint an unfenced pane (caller must take the full capture)', () => {
    it('root shell missing from the capture', async () => {
      expect(await fp([foreign(), agent()])).toBeNull()
    })

    it('root shell has no start marker', async () => {
      expect(await fp([shell({ startTime: undefined }), agent()])).toBeNull()
    })

    it('root shell has no job-control columns', async () => {
      expect(await fp([shell({ pgid: undefined, tpgid: undefined }), agent()])).toBeNull()
    })
  })

  describe('Linux', () => {
    it('reads /proc start times for the pane subtree only and ignores ps start markers', async () => {
      const asked: number[] = []
      const read = async (pid: number): Promise<string | null> => {
        asked.push(pid)
        return pid === SHELL ? '1000' : pid === AGENT ? '2000' : null
      }
      const rows = [foreign(), shell({ startTime: undefined }), agent({ startTime: undefined })]
      const a = await buildPaneProcessFingerprint(rows, SHELL, {
        platform: 'linux',
        readLinuxStartTime: read
      })
      expect(a).toContain(`${SHELL}@1000`)
      expect(a).toContain(`${AGENT}@2000`)
      expect(asked.sort()).toEqual([SHELL, AGENT].sort())
      // An exit-and-replace changes only the /proc start ticks.
      const replaced = await buildPaneProcessFingerprint(rows, SHELL, {
        platform: 'linux',
        readLinuxStartTime: async (pid) => (pid === AGENT ? '2500' : read(pid))
      })
      expect(replaced).not.toBe(a)
    })

    it('refuses when the root /proc entry cannot be read', async () => {
      expect(
        await buildPaneProcessFingerprint([shell(), agent()], SHELL, {
          platform: 'linux',
          readLinuxStartTime: async () => null
        })
      ).toBeNull()
    })
    it('refuses when a DESCENDANT start marker cannot be read', async () => {
      // Why: the start marker is what makes a pid comparison recycle-safe. Stamping a missing
      // one as a placeholder let two captures that both failed to read it compare equal across
      // a recycled pid, so a vanished agent looked unchanged and the cheap tier kept serving
      // its name. Refusing sends the caller to the full capture.
      const rows = [shell(), agent()]

      expect(
        await buildPaneProcessFingerprint(rows, SHELL, {
          platform: 'linux',
          readLinuxStartTime: async (pid) => (pid === SHELL ? '2400' : null)
        })
      ).toBeNull()
    })

    it('does not let a recycled descendant pid reuse a fingerprint', async () => {
      // Both captures fail to read the descendant marker; the pid is reused by a different
      // process in between. Equal fingerprints here would mask the agent's exit.
      const readNoDescendant = async (pid: number): Promise<string | null> =>
        pid === SHELL ? '2400' : null
      const before = await buildPaneProcessFingerprint([shell(), agent()], SHELL, {
        platform: 'linux',
        readLinuxStartTime: readNoDescendant
      })
      const after = await buildPaneProcessFingerprint(
        [shell(), agent({ stat: 'S+', pgid: AGENT })],
        SHELL,
        { platform: 'linux', readLinuxStartTime: readNoDescendant }
      )

      expect(before).toBeNull()
      expect(after).toBeNull()
    })
  })
})
