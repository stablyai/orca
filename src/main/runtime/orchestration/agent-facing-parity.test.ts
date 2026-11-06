import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  getAppEnvironment,
  hasAppEnvironment,
  setAppEnvironment,
  type AppEnvironment
} from '../../../shared/app-environment'

import {
  localOrchestrationCliCommand,
  resolveTerminalOrchestrationCliCommand,
  runtimeOrchestrationCliCommand,
  type OrchestrationCliCommand
} from './cli-command'
import { OrchestrationDb } from './db'
import { OrchestrationStructuredMailboxPointerDelivery } from './structured-mailbox-pointer-delivery'

const CHAT_SESSION = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'
const CHAT_ADDRESS = `orca_session_id:${CHAT_SESSION}`

const db = new OrchestrationDb(':memory:')

const previousEnvironment = hasAppEnvironment() ? getAppEnvironment() : null

afterEach(() => {
  if (previousEnvironment) {
    setAppEnvironment(previousEnvironment)
  }
})

afterAll(() => {
  db.close()
})

function installApp(isPackaged: boolean): void {
  setAppEnvironment({
    getPath: () => '/tmp/orca-parity',
    getAppPath: () => '/tmp/orca-parity',
    getVersion: () => '0.0.0-test',
    isPackaged: () => isPackaged,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  } satisfies AppEnvironment)
}

/** Render what the structured lane hands a chat for one mailbox message. */
async function renderChatMail(mailbox: string): Promise<{ text: string; id: string }> {
  const texts: string[] = []
  const message = db.insertMessage({ from: 'term_peer', to: mailbox, subject: 'hi' })
  const delivery = new OrchestrationStructuredMailboxPointerDelivery({
    getDb: () => db,
    getMessageWaiters: () => undefined,
    resolveStructuredTarget: () => ({ sessionId: CHAT_SESSION, dispatchId: null }),
    mailboxEnded: () => false,
    getCliCommand: localOrchestrationCliCommand,
    senderSnapshot: () => ({ name: null, agent: null }),
    host: {
      currentFence: () => 1,
      watchJournal: () => () => {},
      observe: async () => ({ kind: 'accepted' }),
      wakeQueue: () => {},
      withdraw: async () => true,
      send: async (input) => {
        for (const block of input.body.blocks) {
          texts.push(block.type === 'text' ? block.text : '')
        }
        return { kind: 'sent', state: 'accepted' }
      }
    }
  })
  delivery.deliverForHandle(mailbox)
  await vi.waitFor(() => expect(texts).toHaveLength(1))
  return { text: texts[0]!, id: message.id }
}

describe('a chat agent and a terminal agent see the same text but for how each is named and called', () => {
  it.each([
    ['a packaged app', true],
    ['a dev build', false]
  ])(
    'names the CLI the PTY lane types into a local terminal in a chat message, in %s',
    async (_label, packaged) => {
      installApp(packaged)
      const terminalCli: OrchestrationCliCommand = resolveTerminalOrchestrationCliCommand({
        connectionId: null,
        isWsl: false,
        worktreeId: 'repo::/tmp/wt',
        runtimeCliCommand: runtimeOrchestrationCliCommand()
      })
      expect(terminalCli).toBe(packaged ? 'orca' : 'orca-dev')

      for (const mailbox of ['run:run_parity', CHAT_ADDRESS]) {
        const { text, id } = await renderChatMail(mailbox)
        expect(text).toContain(`[Reply: ${terminalCli} orchestration reply --id ${id}`)
      }
    }
  )
})
