import './rpc/unused-default-rpc-methods.test-fixture'
import { RpcDispatcher } from './rpc/dispatcher'
import { TERMINAL_SEND_METHODS } from './rpc/methods/terminal/terminal-send-method'
import { createPtyWriteInput } from '../ipc/pty/ipc/write-input'
import { writePtyFromRuntimeController } from '../ipc/pty/runtime/operations'
import * as providers from '../ipc/pty/provider/registry'
import { ptyOwnership } from '../ipc/pty/provider/ownership-state'
import { LocalPtyProvider } from '../providers/local-pty-provider'
import {
  WRITE_ACCEPTED,
  writeRefused,
  writeUnverifiable,
  type WriteSettlement
} from '../../shared/pty-write-settlement'
import type { WriteSettlementSink } from '../../shared/chat-stop-input'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRuntimeWithHookRows,
  makeAgentStatusStoreWiring
} from './agent-status-store-wiring.test-fixture'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { makePaneKey } from '../../shared/stable-pane-id'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TAB_ID = 'ask-tab'
const WORKTREE_ID = 'wt-1'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const PTY_ID = 'pty-ask'

describe('explicit Stop through execution-host input seams', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    ptyOwnership.delete(PTY_ID)
  })

  async function setup(agentType: AgentStatusIpcPayload['agentType'] = 'grok') {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const wiring = makeAgentStatusStoreWiring()
    const runtime = await createRuntimeWithHookRows([], wiring)
    const provider = new LocalPtyProvider()
    const callbacks: (WriteSettlementSink | undefined)[] = []
    const physical = vi.spyOn(provider, 'write').mockImplementation((_id, _data, sink) => {
      callbacks.push(sink)
      return true
    })
    vi.spyOn(providers, 'tryGetProviderForPty').mockReturnValue(provider)
    vi.spyOn(providers, 'getProviderForPty').mockReturnValue(provider)
    ptyOwnership.set(PTY_ID, 'local')
    runtime.setPtyController({
      spawn: vi.fn(),
      kill: () => true,
      getForegroundProcess: async () => null,
      write: (id, data, kind, sink) =>
        writePtyFromRuntimeController({ runtime }, id, data, kind, { onSettlement: sink })
    })
    const ingest = (state: 'working' | 'done' = 'working', prompt = 'continue') =>
      wiring.statusStore.ingestTerminalStatus({
        paneKey: PANE_KEY,
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        payload: { state, prompt, agentType }
      })
    ingest()
    const ipc = createPtyWriteInput({ runtime })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_SEND_METHODS })
    const handle = runtime.getTerminalHandleForPaneKey(PANE_KEY)
    const send = async (index: 1 | 2, id = 'stop', local = false, tagged = true, mobile = false) =>
      local
        ? ipc.writePtyInputAccepted({
            id: PTY_ID,
            data: '\x1b',
            inputKind: 'driving',
            ...(tagged ? { chatStop: { id, index } } : {})
          })
        : dispatcher.dispatch({
            id: `request-${callbacks.length}`,
            authToken: 'test',
            method: 'terminal.send',
            params: {
              terminal: handle,
              text: '\x1b',
              ...(tagged ? { chatStop: { id, index } } : {}),
              client: { type: mobile ? 'mobile' : 'desktop', id: mobile ? 'mobile' : 'desktop' }
            }
          })
    const settle = (index: number, result: WriteSettlement = WRITE_ACCEPTED) =>
      callbacks[index]?.(result)
    const row = () => wiring.statusStore.getStatusSnapshot()[0]
    return { wiring, runtime, physical, send, settle, row, ingest, dispatcher, handle }
  }

  it.each([2, 20])(
    'bounds pending evidence and work for %i Stop inputs on one pane',
    async (count) => {
      const t = await setup()
      try {
        const capture = vi.spyOn(t.wiring.statusStore, 'captureChatStopInput')
        const infer = vi.spyOn(t.wiring.statusStore, 'inferInterrupt')
        const timers = vi.getTimerCount()
        for (let i = 0; i < count; i += 1) {
          await t.send(1, `stop-${i}`, true)
        }
        expect(capture).toHaveBeenCalledTimes(count)
        expect(t.physical).toHaveBeenCalledTimes(count)
        expect(vi.getTimerCount() - timers).toBe(1)
        for (let i = 0; i < count - 1; i += 1) {
          t.settle(i)
        }
        await vi.advanceTimersByTimeAsync(500)
        expect(infer).not.toHaveBeenCalled()
        t.settle(count - 1)
        await vi.advanceTimersByTimeAsync(500)
        expect(infer).toHaveBeenCalledOnce()
        expect(t.row()?.interrupted).toBe(true)
      } finally {
        t.wiring.statusStore.stop()
      }
    }
  )

  it.each(['ipc', 'desktop', 'mobile'] as const)(
    'publishes canonical cancellation to tab/phone readers through %s',
    async (surface) => {
      const t = await setup()
      try {
        if (surface === 'mobile') {
          await t.runtime.handleMobileSubscribe(PTY_ID, 'mobile', { cols: 45, rows: 20 })
        }
        const reply = await t.send(1, 'stop', surface === 'ipc', true, surface === 'mobile')
        if (surface === 'ipc') {
          expect(reply).toBe(true)
        } else {
          expect(reply).toMatchObject({
            ok: true,
            result: { send: { accepted: true, bytesWritten: 1 } }
          })
        }
        expect(t.row()).toMatchObject({ state: 'working' })
        t.settle(0)
        await vi.advanceTimersByTimeAsync(500)
        expect(t.row()).toMatchObject({ state: 'done', interrupted: true })
        const tabs = await t.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
        expect(tabs.tabs[0]?.type === 'terminal' && tabs.tabs[0].agentStatus).toMatchObject({
          state: 'done',
          interrupted: true
        })
        await vi.advanceTimersByTimeAsync(37_000)
        await t.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
        expect(t.row()).toMatchObject({ state: 'done', interrupted: true })
        t.ingest()
        expect(t.row()).toMatchObject({ state: 'working' })
        expect(t.physical).toHaveBeenCalledTimes(1)
      } finally {
        t.wiring.statusStore.stop()
      }
    }
  )

  it('keeps an older untagged client on its original route without inferred status', async () => {
    const t = await setup()
    try {
      await t.send(1, 'old', false, false)
      t.settle(0)
      await vi.advanceTimersByTimeAsync(500)
      expect(t.physical).toHaveBeenCalledTimes(1)
      expect(t.row()?.state).toBe('working')
    } finally {
      t.wiring.statusStore.stop()
    }
  })

  it('ignores malformed observation metadata and contains capture failure before the same ordinary write', async () => {
    const t = await setup()
    try {
      const reply = await t.dispatcher.dispatch({
        id: 'bad-metadata',
        authToken: 'test',
        method: 'terminal.send',
        params: { terminal: t.handle, text: '\x1b', chatStop: { id: '', index: 1 } }
      })
      expect(reply).toMatchObject({ ok: true, result: { send: { accepted: true } } })
      vi.spyOn(t.wiring.statusStore, 'captureChatStopInput').mockImplementationOnce(() => {
        throw new Error('bookkeeping failed')
      })
      expect(await t.send(1, 'stop', true)).toBe(true)
      await vi.advanceTimersByTimeAsync(500)
      expect(t.physical).toHaveBeenCalledTimes(2)
      expect(t.row()?.state).toBe('working')
    } finally {
      t.wiring.statusStore.stop()
    }
  })

  it.each(['unsupported', 'throw'] as const)(
    'keeps %s ordinary input at one write without inventing cancellation',
    async (mode) => {
      const t = await setup()
      try {
        t.physical.mockImplementationOnce(() => {
          if (mode === 'throw') {
            throw new Error('after handoff')
          }
          return true
        })
        await t.send(1, 'stop', true)
        await vi.advanceTimersByTimeAsync(500)
        expect(t.physical).toHaveBeenCalledTimes(1)
        expect(t.row()?.state).toBe('working')
      } finally {
        t.wiring.statusStore.stop()
      }
    }
  )

  it.each(['claude', 'codex', 'omp', 'pi', 'prime-agent'] as const)(
    'keeps navigation Escape ambiguous for %s',
    async (agent) => {
      const t = await setup(agent)
      try {
        await t.send(1)
        t.settle(0)
        await t.send(2)
        t.settle(1)
        await vi.advanceTimersByTimeAsync(500)
        expect(t.row()?.state).toBe('working')
      } finally {
        t.wiring.statusStore.stop()
      }
    }
  )

  it('keeps a completed action closed when its duplicate index1 reaches a new row', async () => {
    const t = await setup()
    try {
      await t.send(1)
      t.settle(0)
      await vi.advanceTimersByTimeAsync(500)
      expect(t.row()?.interrupted).toBe(true)
      t.ingest('working', 'replacement')
      expect(t.row()?.state).toBe('working')
      await t.send(1)
      t.settle(1)
      await t.send(2)
      t.settle(2)
      await vi.advanceTimersByTimeAsync(500)
      expect(t.row()?.state).toBe('working')
      expect(t.physical).toHaveBeenCalledTimes(3)
    } finally {
      t.wiring.statusStore.stop()
    }
  })

  it.each(['opencode', 'opencode2', 'zcode'] as const)(
    'requires both original %s controls, even with reversed/duplicate callbacks',
    async (agent) => {
      const t = await setup(agent)
      try {
        await t.send(1)
        await vi.advanceTimersByTimeAsync(1000)
        await t.send(2)
        t.settle(1)
        t.settle(1)
        expect(t.row()?.state).toBe('working')
        t.settle(0)
        expect(t.row()).toMatchObject({ state: 'done', interrupted: true, agentType: agent })
      } finally {
        t.wiring.statusStore.stop()
      }
    }
  )

  it.each([
    writeRefused('provider_refused_write'),
    writeUnverifiable('settlement_timeout', true),
    undefined
  ])('does not turn missing/negative proof into acceptance: %j', async (result) => {
    const t = await setup('zcode')
    try {
      await t.send(1)
      if (result) {
        t.settle(0, result)
      }
      await t.send(1) // A duplicate request still writes, but supplies no replacement credit.
      t.settle(1)
      await t.send(2)
      t.settle(2)
      await vi.advanceTimersByTimeAsync(500)
      expect(t.physical).toHaveBeenCalledTimes(3)
      expect(t.row()?.state).toBe('working')
    } finally {
      t.wiring.statusStore.stop()
    }
  })

  it('allows the second original phone control to prove a single-key Stop after first refusal', async () => {
    const t = await setup()
    try {
      await t.send(1)
      t.settle(0, writeRefused('provider_refused_write'))
      await t.send(2)
      t.settle(1)
      await vi.advanceTimersByTimeAsync(500)
      expect(t.row()).toMatchObject({ interrupted: true })
    } finally {
      t.wiring.statusStore.stop()
    }
  })

  it.each(['working', 'done'] as const)(
    'rejects a same-ms same-text %s replacement without suppressing input',
    async (state) => {
      const t = await setup('zcode')
      try {
        await t.send(1)
        t.settle(0)
        t.ingest(state)
        await t.send(2)
        t.settle(1)
        expect(t.physical).toHaveBeenCalledTimes(2)
        expect(t.row()?.state).toBe(state)
        expect(t.row()?.interrupted).not.toBe(true)
      } finally {
        t.wiring.statusStore.stop()
      }
    }
  )

  it.each(['expiry', 'index2first', 'supersede', 'binding', 'stop'] as const)(
    'retires stale evidence on %s, leaving late input ordinary',
    async (cause) => {
      const t = await setup()
      try {
        await t.send(cause === 'index2first' ? 2 : 1)
        if (cause === 'expiry') {
          await vi.advanceTimersByTimeAsync(37_000)
        }
        if (cause === 'supersede') {
          await t.send(1, 'new')
        }
        if (cause === 'binding') {
          t.runtime.synchronizePtyOutputSequenceFromProvider(
            PTY_ID,
            { value: 0, generation: 'reset' },
            t.runtime.getPtyOutputSequence(PTY_ID)
          )
        }
        if (cause === 'stop') {
          t.wiring.statusStore.stop({ keepStatus: true })
        }
        t.ingest()
        t.settle(0)
        await t.send(cause === 'index2first' ? 1 : 2)
        t.settle(cause === 'supersede' ? 2 : 1)
        await vi.advanceTimersByTimeAsync(500)
        expect(t.row()?.state).toBe('working')
        expect(t.physical).toHaveBeenCalledTimes(cause === 'supersede' ? 3 : 2)
      } finally {
        t.wiring.statusStore.stop()
      }
    }
  )
})
