import { describe, expect, it, vi } from 'vitest'
import { hashCanonical } from '../runtime/rpc/orchestration/mutations/orchestration-mutation-receipt'
import type { ConversationKey } from './external-conversation-types'
import {
  fakeLauncher,
  fakeLinkStore,
  fakeTerminal,
  launchResult,
  LOCAL_REPO,
  PANE,
  WORKTREE
} from './external-conversation.test-fixture'
import { deferred, harness } from './external-conversation-seam.test-fixture'

const KEY: ConversationKey = { source: 'dev', externalId: 'thread-1' }
const TARGET = { kind: 'existing' as const, worktree: `id:${WORKTREE}` }
const START = { agent: 'claude', target: TARGET, prompt: 'first' }

const UNKNOWN = { outcome: 'unknown', reason: 'launch_outcome_unknown' }

describe('ExternalConversationSeam start', () => {
  it('answers a launch that fails after publishing as linked but unknown', async () => {
    const { seam, row } = harness()
    const { launcher } = fakeLauncher(async () => {
      throw new Error('prompt delivery crashed')
    })
    expect(
      (await seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd1', START)).initial
    ).toEqual(UNKNOWN)
    expect(row(WORKTREE)?.externalConversations).toHaveLength(1)
  })

  it('throws a launch that fails before publishing, links nothing, and lets the id retry', async () => {
    const { seam, row } = harness()
    const failing = fakeLauncher(
      async () => {
        throw new Error('selector_not_found')
      },
      undefined,
      false
    )
    await expect(
      seam.start(
        { launcher: failing.launcher, terminal: fakeTerminal().terminal },
        KEY,
        'd1',
        START
      )
    ).rejects.toThrow('selector_not_found')
    expect(row(WORKTREE)).toBeUndefined()
    const { launcher } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    expect(
      (await seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd1', START)).initial
    ).toEqual({
      outcome: 'accepted'
    })
  })

  it('shares one creation between concurrent distinct starts and sends the second prompt', async () => {
    const { seam } = harness()
    const launched = deferred<void>()
    const { launcher, launch } = fakeLauncher(async () => {
      await launched.promise
      return launchResult('handed-to-terminal')
    })
    const terminal = fakeTerminal()
    const host = { launcher, terminal: terminal.terminal }
    const first = seam.start(host, KEY, 'd1', START)
    const second = seam.start(host, KEY, 'd2', { ...START, prompt: 'second' })
    launched.resolve()
    expect((await first).initial).toEqual({ outcome: 'accepted' })
    expect((await second).initial).toEqual({ outcome: 'accepted' })
    expect(launch).toHaveBeenCalledTimes(1)
    expect(terminal.writes).toEqual(['second'])
  })

  it('answers a start rebuilt from a link alone as unknown, without launching', async () => {
    const { seam, put } = harness()
    put(WORKTREE, 'local', {
      externalConversations: [{ ...KEY, paneKey: PANE, agent: 'claude', createdAt: 1 }]
    })
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    expect(
      (await seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd1', START)).initial
    ).toEqual(UNKNOWN)
    expect(launch).not.toHaveBeenCalled()
  })
})

describe('ExternalConversationSeam delivery ids', () => {
  it('shares one answer for a repeated id and payload, and refuses another payload', async () => {
    const { seam } = harness()
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    const first = seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd1', START)
    const replay = seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd1', START)
    expect((await first).initial).toEqual({ outcome: 'accepted' })
    expect((await replay).initial).toEqual({ outcome: 'accepted' })
    expect(launch).toHaveBeenCalledTimes(1)
    expect(
      (
        await seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd1', {
          ...START,
          prompt: 'x'
        })
      ).initial
    ).toEqual({
      outcome: 'refused',
      reason: 'delivery_id_reused'
    })
  })

  it('keeps its answer across a restart, and reads an interrupted one as unknown', async () => {
    const { seam, restart, db } = harness()
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    await seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd1', START)
    expect(
      (await restart().start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd1', START))
        .initial
    ).toEqual({
      outcome: 'accepted'
    })
    // A pending receipt models process loss during the first start.
    db.beginMutationReceipt({
      callerFingerprint: 'connector:dev',
      requestId: JSON.stringify(['thread-9', 'd1']),
      method: 'connector.start',
      payloadHash: hashCanonical([START.agent, START.target, START.prompt])
    })
    const lost = await restart().start(
      { launcher, terminal: fakeTerminal().terminal },
      { ...KEY, externalId: 'thread-9' },
      'd1',
      START
    )
    expect(lost.initial).toEqual({ outcome: 'unknown', reason: 'replayed_after_restart' })
    expect(launch).toHaveBeenCalledTimes(1)
  })
})

describe('ExternalConversationSeam links', () => {
  it('finds an SSH twin’s link that only its host’s row holds, after a restart too', async () => {
    const records = fakeLinkStore([LOCAL_REPO, { ...LOCAL_REPO, connectionId: 'box' }])
    // The locator projection keeps the local twin; the SSH link exists only in canonical host rows.
    records.put(WORKTREE, 'local', {})
    const { seam, restart, writes } = harness({}, records)
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'), {
      worktreeId: WORKTREE,
      sshHostId: 'ssh:box'
    })
    await seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd1', START)
    expect(writes.at(-1)).toEqual({ id: WORKTREE, hostId: 'ssh:box' })
    expect(records.row(WORKTREE)?.externalConversations).toBeUndefined()
    expect(
      (await restart().start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd2', START))
        .initial
    ).toEqual(UNKNOWN)
    expect(launch).toHaveBeenCalledTimes(1)
  })
})

describe('ExternalConversationSeam disposal', () => {
  it('settles a queued start at once while the active launch keeps its real outcome', async () => {
    const { seam } = harness()
    const launched = deferred<void>()
    const { launcher, launch } = fakeLauncher(async () => {
      await launched.promise
      return launchResult('handed-to-terminal')
    })
    const first = seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd1', START)
    const queued = seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd2', {
      ...START,
      prompt: 'second'
    })
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
    seam.dispose('connectors_disabled')
    expect((await queued).initial).toEqual({ outcome: 'refused', reason: 'connectors_disabled' })
    launched.resolve()
    expect((await first).initial).toEqual({ outcome: 'accepted' })
  })

  it('refuses a launch the disable stopped before the agent existed', async () => {
    const { seam, row } = harness()
    const { launcher } = fakeLauncher(
      async () => {
        seam.dispose('connectors_disabled')
        throw new Error('request_aborted')
      },
      undefined,
      false
    )
    expect(
      (await seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd1', START)).initial
    ).toEqual({
      outcome: 'refused',
      reason: 'connectors_disabled'
    })
    expect(row(WORKTREE)).toBeUndefined()
  })
})

async function started() {
  const terminal = fakeTerminal()
  const h = harness({}, undefined, undefined, terminal.terminal)
  const { launcher } = fakeLauncher(async () => launchResult('handed-to-terminal'))
  const host = { launcher, terminal: terminal.terminal }
  await h.seam.start(host, KEY, 'start', START)
  return { ...h, terminal, host }
}

describe('ExternalConversationSeam send', () => {
  it('refuses when the agent’s pane is gone, or a new process took it before the write', async () => {
    const { seam, host, terminal } = await started()
    terminal.sendTerminalAgentPrompt.mockImplementationOnce(async () => {
      throw new Error('terminal_handle_stale')
    })
    expect(await seam.send(host, KEY, 'd1', 'x')).toEqual({
      outcome: 'refused',
      reason: 'agent_not_reachable'
    })
    terminal.exit()
    expect(await seam.send(host, KEY, 'd2', 'y')).toEqual({
      outcome: 'refused',
      reason: 'agent_not_reachable'
    })
    expect(terminal.writes).toEqual([])
  })

  it('keeps arrival order behind a held head and sends both after the answer', async () => {
    const { seam, host, terminal } = await started()
    terminal.state.blocked = true
    const head = seam.send(host, KEY, 'd1', 'one')
    const follower = seam.send(host, KEY, 'd2', 'two')
    await vi.waitFor(() => expect(terminal.held()).toBe(1))
    terminal.answer()
    expect(await head).toEqual({ outcome: 'accepted' })
    expect(await follower).toEqual({ outcome: 'accepted' })
    expect(terminal.writes).toEqual(['one', 'two'])
  })

  it('settles a held head and its follower when connectors are turned off', async () => {
    const { seam, host, terminal } = await started()
    terminal.state.blocked = true
    const head = seam.send(host, KEY, 'd1', 'one')
    const follower = seam.send(host, KEY, 'd2', 'two')
    await vi.waitFor(() => expect(terminal.held()).toBe(1))
    seam.dispose('connectors_disabled')
    const disabled = { outcome: 'refused', reason: 'connectors_disabled' }
    expect(await head).toEqual(disabled)
    expect(await follower).toEqual(disabled)
    expect(terminal.held()).toBe(0)
    expect(terminal.writes).toEqual([])
  })

  it('settles a held head and its follower when its workspace is removed, PTY still registered', async () => {
    const { seam, host, terminal, removeWorkspace, remove } = await started()
    terminal.state.blocked = true
    const head = seam.send(host, KEY, 'd1', 'one')
    const follower = seam.send(host, KEY, 'd2', 'two')
    await vi.waitFor(() => expect(terminal.held()).toBe(1))
    remove(WORKTREE)
    removeWorkspace(WORKTREE)
    const gone = { outcome: 'refused', reason: 'agent_not_reachable' }
    expect(await head).toEqual(gone)
    expect(await follower).toEqual(gone)
    expect(terminal.held()).toBe(0)
  })

  it('settles a follower behind an exited head without retargeting it', async () => {
    const { seam, host, terminal } = await started()
    terminal.state.blocked = true
    const head = seam.send(host, KEY, 'd1', 'one')
    const follower = seam.send(host, KEY, 'd2', 'two')
    await vi.waitFor(() => expect(terminal.held()).toBe(1))
    terminal.exit()
    const gone = { outcome: 'refused', reason: 'agent_not_reachable' }
    expect(await head).toEqual(gone)
    expect(await follower).toEqual(gone)
    expect(terminal.writes).toEqual([])
  })

  it('settles the held head and its follower when a new process takes the pane, same PTY id', async () => {
    const { seam, host, terminal } = await started()
    terminal.state.blocked = true
    const head = seam.send(host, KEY, 'd1', 'one')
    const follower = seam.send(host, KEY, 'd2', 'two')
    await vi.waitFor(() => expect(terminal.held()).toBe(1))
    terminal.replace()
    terminal.answer()
    const gone = { outcome: 'refused', reason: 'agent_not_reachable' }
    expect(await head).toEqual(gone)
    expect(await follower).toEqual(gone)
    expect(terminal.writes).toEqual([])
    expect(await seam.send(host, KEY, 'd3', 'three')).toEqual({ outcome: 'accepted' })
    expect(terminal.writes).toEqual(['three'])
  })

  it('settles a follower when the replacement shows up as the head’s rejection', async () => {
    const { seam, host, terminal } = await started()
    terminal.sendTerminalAgentPrompt.mockImplementationOnce(async () => {
      terminal.replace()
      throw new Error('terminal_not_writable')
    })
    const head = seam.send(host, KEY, 'd1', 'one')
    const follower = seam.send(host, KEY, 'd2', 'two')
    const gone = { outcome: 'refused', reason: 'agent_not_reachable' }
    expect(await head).toEqual(gone)
    expect(await follower).toEqual(gone)
    expect(terminal.writes).toEqual([])
  })

  it('settles a follower whose admitted process was replaced after the head wrote', async () => {
    const { seam, host, terminal } = await started()
    terminal.sendTerminalAgentPrompt.mockImplementationOnce(async (handle, prompt) => {
      terminal.writes.push(prompt)
      terminal.replace()
      return { handle, accepted: true, bytesWritten: 1 }
    })
    const head = seam.send(host, KEY, 'd1', 'one')
    const follower = seam.send(host, KEY, 'd2', 'two')
    expect(await head).toEqual({ outcome: 'accepted' })
    expect(await follower).toEqual({ outcome: 'refused', reason: 'agent_not_reachable' })
    expect(terminal.writes).toEqual(['one'])
  })
})

describe('ExternalConversationSeam twin removal', () => {
  async function twins(linkedHost: 'local' | 'ssh:box') {
    const records = fakeLinkStore([LOCAL_REPO, { ...LOCAL_REPO, connectionId: 'box' }])
    records.put(WORKTREE, 'local', {})
    records.put(WORKTREE, 'ssh:box', {})
    const terminal = fakeTerminal()
    const h = harness({}, records, undefined, terminal.terminal)
    const { launcher } = fakeLauncher(async () => launchResult('handed-to-terminal'), {
      worktreeId: WORKTREE,
      sshHostId: linkedHost === 'local' ? null : linkedHost
    })
    const host = { launcher, terminal: terminal.terminal }
    await h.seam.start(host, KEY, 'start', START)
    terminal.state.blocked = true
    const head = h.seam.send(host, KEY, 'd1', 'one')
    const follower = h.seam.send(host, KEY, 'd2', 'two')
    await vi.waitFor(() => expect(terminal.held()).toBe(1))
    return { ...h, terminal, head, follower }
  }

  it.each([
    ['ssh:box', 'local'],
    ['local', 'ssh:box']
  ] as const)(
    'keeps a conversation on %s held when its %s twin is removed, settles it on its own removal',
    async (linkedHost, twinHost) => {
      const { terminal, head, follower, remove, removeWorkspace } = await twins(linkedHost)
      remove(WORKTREE, twinHost)
      removeWorkspace(WORKTREE)
      expect(terminal.held()).toBe(1)
      remove(WORKTREE, linkedHost)
      removeWorkspace(WORKTREE)
      const gone = { outcome: 'refused', reason: 'agent_not_reachable' }
      expect(await head).toEqual(gone)
      expect(await follower).toEqual(gone)
    }
  )
})

describe('ExternalConversationSeam start-headed lanes', () => {
  const GONE = { outcome: 'refused', reason: 'agent_not_reachable' }

  it('lets no follower adopt a process when the launch published none it can prove', async () => {
    const terminal = fakeTerminal()
    const { seam } = harness({}, undefined, undefined, terminal.terminal)
    terminal.state.ptyId = null
    const launched = deferred<void>()
    const { launcher, launch } = fakeLauncher(async () => {
      await launched.promise
      return launchResult('handed-to-terminal')
    })
    const host = { launcher, terminal: terminal.terminal }
    const start = seam.start(host, KEY, 'start', START)
    await vi.waitFor(() => expect(launch).toHaveBeenCalled())
    const follower = seam.send(host, KEY, 'd1', 'queued')
    terminal.state.ptyId = 'pty-2'
    launched.resolve()
    expect((await start).initial).toEqual({ outcome: 'accepted' })
    expect(await follower).toEqual(GONE)
    expect(terminal.writes).toEqual([])
  })
})
