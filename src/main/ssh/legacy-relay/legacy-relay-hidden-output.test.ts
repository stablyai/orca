import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LegacyRelayHiddenOutput } from './legacy-relay-hidden-output'

const PTY = 'ssh:ssh-box@@pty-1'

type Reread = (ptyId: string, atSnapshot: (replay: string) => void) => Promise<void>

let sent: string[]
let reread: ReturnType<typeof vi.fn<Reread>>
let subject: LegacyRelayHiddenOutput

beforeEach(() => {
  sent = []
  reread = vi.fn<Reread>(async (_ptyId, atSnapshot) => atSnapshot('SCREEN'))
  subject = new LegacyRelayHiddenOutput({
    onData: (_ptyId, data) => sent.push(`data:${data}`),
    onReplay: (_ptyId, replay) => sent.push(`replay:${replay}`),
    reread: (ptyId, atSnapshot) => reread(ptyId, atSnapshot)
  })
})

describe('a bridged pane no visible view shows', () => {
  it('sends none of its output to the window, and one fresh screen once shown', async () => {
    subject.setPaused(PTY, true)
    for (let i = 0; i < 1000; i++) {
      subject.onData(PTY, 'x'.repeat(4096))
    }
    expect(sent).toEqual([])
    subject.setPaused(PTY, false)
    await vi.waitFor(() => expect(sent).toEqual(['replay:SCREEN']))
    expect(reread).toHaveBeenCalledTimes(1)
    subject.onData(PTY, 'live')
    expect(sent).toEqual(['replay:SCREEN', 'data:live'])
  })

  it('keeps output printed after the snapshot behind the screen it follows', async () => {
    let snapshot: (replay: string) => void = () => {}
    let finish: () => void = () => {}
    reread.mockImplementationOnce(
      (_ptyId, atSnapshot) =>
        new Promise<void>((resolve) => {
          snapshot = atSnapshot
          finish = resolve
        })
    )
    subject.setPaused(PTY, true)
    subject.onData(PTY, 'hidden')
    subject.setPaused(PTY, false)
    // The snapshot covers these earlier bytes.
    subject.onData(PTY, 'old')
    snapshot('SCREEN')
    // Post-snapshot bytes must follow the screen even before attach resolves.
    subject.onData(PTY, 'new')
    finish()
    await Promise.resolve()
    expect(sent).toEqual(['replay:SCREEN', 'data:new'])
  })

  it('still sends a hidden program’s terminal queries so the window can answer them', () => {
    subject.setPaused(PTY, true)
    subject.onData(PTY, 'bulk\x1b[cmore')
    expect(sent).toEqual(['data:\x1b[c'])
  })

  it('brings the screen current before a cursor query, so its answer is not stale', async () => {
    subject.setPaused(PTY, true)
    subject.onData(PTY, '\x1b[10;20H\x1b[6n')
    await vi.waitFor(() => expect(sent).toEqual(['replay:SCREEN', 'data:\x1b[6n']))
    subject.onData(PTY, 'more')
    expect(sent).toHaveLength(2)
  })

  it('answers a cursor query stale rather than never when the screen cannot be read', async () => {
    reread.mockRejectedValueOnce(new Error('ssh down'))
    subject.setPaused(PTY, true)
    subject.onData(PTY, '\x1b[6n')
    await vi.waitFor(() => expect(sent).toEqual(['data:\x1b[6n']))
  })

  it('finishes a sequence the reveal’s snapshot split', async () => {
    subject.setPaused(PTY, true)
    subject.onData(PTY, 'bulk\x1b[')
    subject.setPaused(PTY, false)
    await vi.waitFor(() => expect(sent).toEqual(['replay:SCREEN', 'data:\x1b[']))
    subject.onData(PTY, 'c')
    expect(sent.at(-1)).toBe('data:c')
  })

  it('still sends kitty, window-size and capability queries', () => {
    subject.setPaused(PTY, true)
    subject.onData(PTY, 'a\x1b[?ub\x1b[18tc\x1bP+q544e\x1b\\d')
    expect(sent).toEqual(['data:\x1b[?u\x1b[18t\x1bP+q544e\x1b\\'])
  })

  it('reopens an oversized OSC a reveal cut, so its payload never prints', async () => {
    reread.mockRejectedValueOnce(new Error('ssh down'))
    subject.setPaused(PTY, true)
    subject.onData(PTY, `\x1b]1337;File=${'x'.repeat(5000)}`)
    subject.setPaused(PTY, false)
    await vi.waitFor(() => expect(sent).toEqual(['data:\x1b]']))
  })

  it('finishes a query a shown pane started before it was hidden', () => {
    subject.onData(PTY, 'shown\x1b[')
    subject.setPaused(PTY, true)
    subject.onData(PTY, 'cbulk')
    expect(sent).toEqual(['data:shown\x1b[', 'data:\x1b[c'])
  })

  it('carries a query split across chunks until it completes', () => {
    subject.setPaused(PTY, true)
    subject.onData(PTY, 'bulk\x1b[')
    subject.onData(PTY, 'c')
    expect(sent).toEqual(['data:\x1b[c'])
  })

  it('still sends command marks, titles and bells, but not an oversized OSC', () => {
    subject.setPaused(PTY, true)
    subject.onData(PTY, 'out\x1b]133;D;0\x07text\x1b]0;')
    subject.onData(PTY, 'title\x1b\\ding\x07')
    subject.onData(PTY, `\x1b]1337;File=${'x'.repeat(5000)}`)
    subject.onData(PTY, 'y\x07after\x07')
    expect(sent).toEqual(['data:\x1b]133;D;0\x07', 'data:\x1b]0;title\x1b\\\x07', 'data:\x07'])
  })

  it('re-reads nothing for a pane that printed nothing while hidden', async () => {
    subject.setPaused(PTY, true)
    subject.setPaused(PTY, false)
    await Promise.resolve()
    expect(reread).not.toHaveBeenCalled()
    subject.onData(PTY, 'live')
    expect(sent).toEqual(['data:live'])
  })

  it('re-reads nothing when a reattach’s screen already covered what was dropped', async () => {
    subject.setPaused(PTY, true)
    subject.onData(PTY, 'hidden')
    subject.screenSent(PTY)
    subject.setPaused(PTY, false)
    await Promise.resolve()
    expect(reread).not.toHaveBeenCalled()
  })

  it('re-reads output a hidden pane printed after its reattach’s screen', async () => {
    subject.setPaused(PTY, true)
    subject.screenSent(PTY)
    subject.onData(PTY, 'after the screen')
    subject.setPaused(PTY, false)
    await vi.waitFor(() => expect(sent).toEqual(['replay:SCREEN']))
  })

  it('holds a screen that arrives after the pane was hidden again, and reads a newer one', async () => {
    let snapshot: (replay: string) => void = () => {}
    reread.mockImplementationOnce(async (_ptyId, atSnapshot) => {
      snapshot = atSnapshot
    })
    subject.setPaused(PTY, true)
    subject.onData(PTY, 'hidden')
    subject.setPaused(PTY, false)
    subject.setPaused(PTY, true)
    snapshot('STALE')
    await Promise.resolve()
    expect(sent).toEqual([])
    subject.setPaused(PTY, false)
    await vi.waitFor(() => expect(sent).toEqual(['replay:SCREEN']))
  })

  it('shows live output again when the screen cannot be read, leaving the rest to the reattach', async () => {
    reread.mockRejectedValueOnce(new Error('ssh down'))
    subject.setPaused(PTY, true)
    subject.onData(PTY, 'hidden')
    subject.setPaused(PTY, false)
    await vi.waitFor(() => expect(reread).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    subject.onData(PTY, 'live')
    expect(sent).toEqual(['data:live'])
  })

  it('forgets an exited pane, so a reused id starts shown', () => {
    subject.setPaused(PTY, true)
    subject.forget(PTY)
    subject.onData(PTY, 'next')
    expect(sent).toEqual(['data:next'])
  })
})
