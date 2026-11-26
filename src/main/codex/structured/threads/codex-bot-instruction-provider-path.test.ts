import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import { recordStartedHandle } from '../../../native-chat/agent-session-wire/startup/structured-agent-session-start-provider-answer'
import { CodexStructuredSessionAdapter } from '../session-lifecycle/codex-structured-session-adapter'
import {
  NOW,
  openedContext,
  root,
  SNAPSHOT,
  store
} from './codex-bot-instruction-installation.test-support'

it.each(['codex-cli/0.167.1 scripted', 'codex-cli/0.172.0', undefined])(
  'admits a repaired task only with supported app-server handshake %s',
  async (userAgent) => {
    const sessionId = 'release-chat'
    const handle = codexProviderHandle('native-release')
    const fence = store.getRecord(sessionId)!.lease.runtimeFence
    const signal = new AbortController().signal
    await store.updateRecord(sessionId, {
      kind: 'provider-handle',
      args: {
        fence,
        now: NOW,
        link: {
          linkId: 'saved-handle',
          handle,
          origin: 'created',
          mintedAtFence: fence,
          observedAt: NOW
        }
      }
    })
    let closed = false
    let turn = 0
    const request = vi.fn<CodexAppServerConnection['request']>(async (method, _params, options) => {
      const response =
        method === 'initialize'
          ? { userAgent }
          : method === 'thread/resume'
            ? { thread: { id: handle.nativeId }, model: 'test-model', serviceTier: null }
            : method === 'turn/start'
              ? { turn: { id: `turn-${++turn}`, status: 'inProgress', items: [] } }
              : method === 'skills/list'
                ? { data: [] }
                : {}
      options?.onReply?.(response)
      return response
    })
    const adapter = new CodexStructuredSessionAdapter({
      requestTimeoutMs: 1000,
      readProcessStartTime: async () => NOW,
      resolveLaunch: async () => ({
        command: 'scripted-codex',
        args: [],
        cwd: root,
        codexHome: join(root, 'codex'),
        resumeThreadId: handle.nativeId,
        developerInstructions: SNAPSHOT.text,
        instructionInstallation: { store, snapshot: SNAPSHOT, account: '/isolated/codex' }
      }),
      openConnection: async () => ({
        pid: 4242,
        get closed() {
          return closed
        },
        request,
        notify: () => {},
        respond: () => {},
        respondWithError: () => {},
        close: async () => {
          closed = true
          return true
        }
      })
    })
    try {
      const acquired = await adapter.acquire({
        identity: {
          sessionId,
          workspaceId: 'folder:release',
          hostId: 'local',
          agent: 'codex',
          providerHandle: handle
        },
        fence,
        spawnToken: 'spawn-1',
        signal
      })
      const acquisitionGeneration = acquired.acquisitionGeneration!
      const opened = adapter.open({ sessionId, fence, acquisitionGeneration, signal })
      if (userAgent !== 'codex-cli/0.167.1 scripted') {
        await expect(opened).rejects.toMatchObject({ fact: { instructionRecovery: 'unknown' } })
        expect(
          request.mock.calls.filter(
            ([method]) => method === 'thread/inject_items' || method === 'turn/start'
          )
        ).toEqual([])
        return
      }
      const outcome = await opened
      expect(outcome.link?.handle).toEqual(handle)
      expect(
        await recordStartedHandle(openedContext(), {
          ...outcome,
          sessionId,
          fence,
          acquisitionGeneration
        })
      ).toBe(true)
      for (const clientMessageId of ['owner-cold', 'owner-warm']) {
        await adapter.dispatch({
          sessionId,
          fence,
          clientMessageId,
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: clientMessageId }]
          }
        })
      }
      expect(
        request.mock.calls
          .filter(([method]) =>
            ['initialize', 'thread/resume', 'thread/inject_items', 'turn/start'].includes(method)
          )
          .map(([method]) => method)
      ).toEqual(['initialize', 'thread/resume', 'thread/inject_items', 'turn/start', 'turn/start'])
      expect(store.getRecord(sessionId)?.instructionPolicy?.state).toBe('delivered')
    } finally {
      await adapter.releaseAcquisition({ sessionId })
    }
  }
)
