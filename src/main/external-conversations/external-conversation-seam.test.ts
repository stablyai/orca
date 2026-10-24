import { describe, expect, it, vi } from 'vitest'
import { hashCanonical } from '../runtime/rpc/orchestration-mutation-receipt'
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
  it.each([
    ['handed-to-terminal', { outcome: 'accepted' }],
    ['not-delivered', UNKNOWN],
    ['unconfirmed', UNKNOWN]
  ] as const)('maps a %s launch prompt to %o and links the pane', async (prompt, initial) => {
    const { seam, row } = harness()
    const { launcher } = fakeLauncher(async () => launchResult(prompt))
    expect(
      await seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd1', START)
    ).toEqual({
      conversation: KEY,
      initial
    })
    expect(row(WORKTREE)?.externalConversations).toEqual([
      expect.objectContaining({ source: 'dev', externalId: 'thread-1', paneKey: PANE })
    ])
  })

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

  it('passes a signal to the launch that turning connectors off aborts', async () => {
    const { seam } = harness()
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    await seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd1', START)
    const signal = launch.mock.calls[0]?.[2]
    seam.dispose('connectors_disabled')
    expect(signal?.aborted).toBe(true)
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

  it('links a created folder workspace on its folder record', async () => {
    const { seam, folders } = harness()
    folders.push({ id: 'f-1' })
    const { launcher } = fakeLauncher(
      async () => launchResult('handed-to-terminal', 'folder:f-1'),
      {
        worktreeId: 'folder:f-1',
        sshHostId: null
      }
    )
    await seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd1', {
      ...START,
      target: { kind: 'create-folder-workspace', create: { projectGroupId: 'g-1' } }
    })
    expect(folders[0].externalConversations).toEqual([expect.objectContaining({ paneKey: PANE })])
  })

  it.each([
    ['an agent off the list', 'opencode', {}],
    ['an agent without status hooks', 'claude', { agentStatusHooksEnabled: false }]
  ] as const)('refuses %s', async (_label, agent, settings) => {
    const { seam } = harness(settings)
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    expect(
      (
        await seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd1', {
          ...START,
          agent
        })
      ).initial
    ).toEqual({
      outcome: 'refused',
      reason: 'unsupported_agent'
    })
    expect(launch).not.toHaveBeenCalled()
  })
})

describe('ExternalConversationSeam delivery ids', () => {
  it.each([
    ['its workspace cannot be resolved', 'resolve'],
    ['its link cannot be written', 'write']
  ] as const)(
    'keeps an unknown answer, across a restart too, when %s after the launch',
    async (_label, failing) => {
      const { seam, restart, store } = harness()
      const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
      if (failing === 'resolve') {
        launcher.paneWorkspace = async () => {
          throw new Error('scope lost')
        }
      } else {
        store.setWorktreeMeta = () => {
          throw new Error('disk full')
        }
      }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(
        (await seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd1', START))
          .initial
      ).toEqual(UNKNOWN)
      expect(
        (await seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd1', START))
          .initial
      ).toEqual(UNKNOWN)
      expect(
        (await restart().start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd1', START))
          .initial
      ).toEqual(UNKNOWN)
      expect(launch).toHaveBeenCalledTimes(1)
      warn.mockRestore()
    }
  )

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

  it('scopes delivery ids by conversation', async () => {
    const { seam } = harness()
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    await seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd1', START)
    await seam.start(
      { launcher, terminal: fakeTerminal().terminal },
      { ...KEY, externalId: 'thread-2' },
      'd1',
      START
    )
    expect(launch).toHaveBeenCalledTimes(2)
  })
})

describe('ExternalConversationSeam links', () => {
  it('forgets a removed workspace, and follows a renamed one', async () => {
    const { seam, row, put, remove } = harness()
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    await seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd1', START)
    put('repo-1::/work/renamed', 'local', {
      externalConversations: row(WORKTREE)?.externalConversations
    })
    remove(WORKTREE)
    expect(
      (await seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd2', START)).initial
    ).toEqual({ outcome: 'accepted' })
    remove('repo-1::/work/renamed')
    await seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd3', START)
    expect(launch).toHaveBeenCalledTimes(2)
  })

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
  it('sends through the shared writer with the hold and the binding it admitted', async () => {
    const { seam, host, terminal } = await started()
    expect(await seam.send(host, KEY, 'd1', 'hello')).toEqual({ outcome: 'accepted' })
    expect(terminal.writes).toEqual(['hello'])
    expect(terminal.sendTerminalAgentPrompt).toHaveBeenCalledWith(
      'term-1',
      'hello',
      expect.objectContaining({
        inputKind: 'driving',
        onPermission: 'wait',
        expectedBinding: { ptyId: 'pty-1', processIncarnation: 'inc-pty-1' },
        signal: expect.any(AbortSignal)
      })
    )
  })

  it.each([
    ['before', false],
    ['after', true]
  ])(
    'answers a writer that throws %s the guarded write as writer_failed',
    async (_when, guarded) => {
      const { seam, host, terminal } = await started()
      terminal.sendTerminalAgentPrompt.mockImplementationOnce(async (_handle, prompt, options) => {
        if (guarded) {
          await options.beforeWrite?.('pty-1')
          terminal.writes.push(prompt)
        }
        throw new Error('agent_prompt_stalled')
      })
      expect(await seam.send(host, KEY, 'd1', 'hello')).toEqual({
        outcome: 'unknown',
        reason: 'writer_failed'
      })
    }
  )

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

  it('throws for a conversation it never started', async () => {
    const { seam, host } = await started()
    await expect(seam.send(host, { ...KEY, externalId: 'nope' }, 'd1', 'x')).rejects.toThrow(
      'external_conversation_not_found'
    )
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

  it('keeps holding when another workspace is removed', async () => {
    const { seam, host, terminal, removeWorkspace } = await started()
    terminal.state.blocked = true
    const head = seam.send(host, KEY, 'd1', 'one')
    await vi.waitFor(() => expect(terminal.held()).toBe(1))
    removeWorkspace('repo-1::/work/other')
    expect(terminal.held()).toBe(1)
    terminal.answer()
    expect(await head).toEqual({ outcome: 'accepted' })
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
  async function startHeaded(delayLink: boolean) {
    const terminal = fakeTerminal()
    const h = harness({}, undefined, undefined, terminal.terminal)
    const launched = deferred<void>()
    const linkResolved = deferred<void>()
    const { launcher, launch } = fakeLauncher(async () => {
      await launched.promise
      return launchResult('handed-to-terminal')
    })
    const resolveWorkspace = launcher.paneWorkspace
    launcher.paneWorkspace = async (worktreeId) => {
      if (delayLink) {
        await linkResolved.promise
      }
      return resolveWorkspace(worktreeId)
    }
    const host = { launcher, terminal: terminal.terminal }
    const start = h.seam.start(host, KEY, 'start', START)
    await vi.waitFor(() => expect(launch).toHaveBeenCalled())
    return { ...h, terminal, host, start, launched, linkResolved }
  }

  const GONE = { outcome: 'refused', reason: 'agent_not_reachable' }

  it.each([
    ['a new process on the same PTY id', false],
    ['a new process on the same PTY id, link still resolving', true],
    ['another PTY id', false],
    ['another PTY id, link still resolving', true]
  ])('keeps a follower queued behind the launch off %s', async (name, delayLink) => {
    const { seam, host, terminal, start, launched, linkResolved } = await startHeaded(delayLink)
    const follower = seam.send(host, KEY, 'd1', 'queued')
    if (name.startsWith('another')) {
      terminal.state.ptyId = 'pty-2'
    } else {
      terminal.replace()
    }
    launched.resolve()
    linkResolved.resolve()
    expect((await start).initial).toEqual({ outcome: 'accepted' })
    expect(await follower).toEqual(GONE)
    expect(terminal.writes).toEqual([])
    expect(await seam.send(host, KEY, 'd2', 'later')).toEqual({ outcome: 'accepted' })
    expect(terminal.writes).toEqual(['later'])
  })

  it('sends a follower queued behind the launch to the process it launched', async () => {
    const { seam, host, terminal, start, launched } = await startHeaded(false)
    const follower = seam.send(host, KEY, 'd1', 'queued')
    launched.resolve()
    expect((await start).initial).toEqual({ outcome: 'accepted' })
    expect(await follower).toEqual({ outcome: 'accepted' })
    expect(terminal.writes).toEqual(['queued'])
  })

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
