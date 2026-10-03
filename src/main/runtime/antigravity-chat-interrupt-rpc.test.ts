import { expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as nodePty from 'node-pty'
import { LocalPtyProvider } from '../providers/local-pty-provider'
import { ptyProcesses } from '../providers/local-pty-provider-state'
import { WRITE_ACCEPTED } from '../../shared/pty-write-settlement'
import { ANTIGRAVITY_CHAT_INTERRUPT_CAPABILITY } from '../../shared/antigravity-chat-interrupt'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { makeAgentStatusStoreWiring } from './agent-status-store-wiring.test-fixture'
import { RpcDispatcher } from './rpc/dispatcher'
import { NATIVE_CHAT_METHODS } from './rpc/methods/native-chat'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false }
}))

async function harness(
  writeWithSettlement?: (ptyId: string, data: string) => typeof WRITE_ACCEPTED
) {
  const wiring = makeAgentStatusStoreWiring()
  const pane = await createTranscriptPane(
    {
      paneTitle: 'agy',
      foregroundProcess: 'agy',
      data: '',
      writeWithSettlement
    },
    { ...wiring.deps, inferAgentInterrupt: (request) => wiring.statusStore.inferInterrupt(request) }
  )
  const paneKey = pane.runtime.getTerminalPaneKey(pane.handle)
  if (!paneKey) {
    throw new Error('Missing pane')
  }
  wiring.statusStore.ingestRemote(
    {
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      providerSession: { key: 'conversation_id', id: 'private-contract-conversation' },
      payload: { state: 'working', agentType: 'antigravity', prompt: 'private contract task' }
    },
    null
  )
  const row = wiring.statusStore.getStatusSnapshot()[0]
  if (!row.observation) {
    throw new Error('Missing canonical observation')
  }
  const request = {
    id: 'stop-1',
    authToken: 'private-test',
    method: 'nativeChat.interruptAntigravity',
    params: {
      terminal: pane.handle,
      providerSessionId: 'private-contract-conversation',
      observation: {
        authorityId: row.observation.authorityId,
        incarnation: row.observation.incarnation,
        revision: row.observation.revision
      }
    }
  }
  const dispatcher = new RpcDispatcher({ runtime: pane.runtime, methods: NATIVE_CHAT_METHODS })
  return { ...pane, wiring, request, dispatcher }
}

it('advertises only hosts that can settle input and routes the JSON request to canonical inference', async () => {
  const write = vi.fn(() => WRITE_ACCEPTED)
  const h = await harness(write)
  expect(h.runtime.getStatus().capabilities).toContain(ANTIGRAVITY_CHAT_INTERRUPT_CAPABILITY)
  const result = await h.dispatcher.dispatch(JSON.parse(JSON.stringify(h.request)))
  expect(result).toMatchObject({ ok: true, result: { accepted: true, inferred: true } })
  expect(write).toHaveBeenCalledExactlyOnceWith(TRANSCRIPT_PANE_PTY_ID, '\x1b', 'driving')
  expect(h.wiring.statusStore.getStatusSnapshot()[0]).toMatchObject({
    state: 'done',
    interrupted: true
  })
})

it('never invents accepted input from a legacy boolean write controller', async () => {
  const h = await harness()
  expect(h.runtime.getStatus().capabilities).not.toContain(ANTIGRAVITY_CHAT_INTERRUPT_CAPABILITY)
  expect(await h.dispatcher.dispatch(h.request)).toMatchObject({
    ok: true,
    result: {
      accepted: false,
      inferred: false,
      reason: 'unsupported'
    }
  })
  expect(h.wiring.statusStore.getStatusSnapshot()[0].state).toBe('working')
})

it.skipIf(process.env.ORCA_REAL_AGY_STOP_PTY_TEST !== '1' || process.platform === 'win32')(
  'delivers Escape to a real private PTY through the production local provider before inferring',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-agy-stop-contract-'))
    const terminal = nodePty.spawn(
      process.execPath,
      [
        '-e',
        "process.stdin.setRawMode(true);process.stdin.resume();console.log('PRIVATE_PTY_READY');process.stdin.on('data',b=>{if(b.includes(27))console.log('PRIVATE_PTY_ESCAPE_ACCEPTED')})"
      ],
      {
        name: 'xterm-256color',
        cols: 99,
        rows: 52,
        cwd: directory,
        env: { PATH: process.env.PATH ?? '', HOME: directory, ORCA_BACKGROUND_LAUNCH: '1' }
      }
    )
    let transcript = ''
    const data = terminal.onData((chunk) => {
      transcript += chunk
    })
    const exit = new Promise<void>((resolve) => terminal.onExit(() => resolve()))
    const provider = new LocalPtyProvider({})
    ptyProcesses.set(TRANSCRIPT_PANE_PTY_ID, terminal)
    try {
      await vi.waitFor(() => expect(transcript).toContain('PRIVATE_PTY_READY'))
      const h = await harness((id, bytes) => provider.writeWithSettlement(id, bytes))
      const listener = vi.fn()
      h.wiring.statusStore.setListener(listener)
      listener.mockClear()
      const before = h.wiring.statusStore.getStatusSnapshot()[0]
      const result = await h.dispatcher.dispatch(h.request)
      await vi.waitFor(() => expect(transcript).toContain('PRIVATE_PTY_ESCAPE_ACCEPTED'))
      expect(result).toMatchObject({ ok: true, result: { accepted: true, inferred: true } })
      expect(h.wiring.statusStore.getStatusSnapshot()[0]).toMatchObject({
        state: 'done',
        interrupted: true,
        paneKey: before.paneKey,
        providerSession: before.providerSession,
        observation: {
          authorityId: before.observation?.authorityId,
          incarnation: before.observation?.incarnation,
          revision: (before.observation?.revision ?? -1) + 1
        }
      })
      expect(listener).toHaveBeenCalledTimes(1)
      expect(await h.dispatcher.dispatch(h.request)).toMatchObject({
        ok: true,
        result: { accepted: false, inferred: false }
      })
      expect(listener).toHaveBeenCalledTimes(1)
      const proof = {
        provider: 'production LocalPtyProvider',
        consumer: 'controlled raw-input Node child, not Antigravity CLI',
        transcript: transcript.slice(-512),
        before: {
          state: before.state,
          providerSession: before.providerSession,
          observation: before.observation
        },
        after: h.wiring.statusStore
          .getStatusSnapshot()
          .map(({ state, interrupted, providerSession, observation }) => ({
            state,
            interrupted,
            providerSession,
            observation
          })),
        canonicalInterruptUpdates: listener.mock.calls.length
      }
      if (process.env.ORCA_AGY_STOP_PROOF_PATH) {
        writeFileSync(process.env.ORCA_AGY_STOP_PROOF_PATH, JSON.stringify(proof, null, 2))
      }
    } finally {
      ptyProcesses.delete(TRANSCRIPT_PANE_PTY_ID)
      terminal.kill()
      await exit
      data.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
