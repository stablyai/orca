import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DshStructuredSessionAdapter } from './dsh-structured-session-adapter'
import { DSH_ACP_PEER } from './dsh-acp-peer.test-fixture'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'

it('retains the official upstream assistant image without ending its session', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-image-peer-review-'))
  const imagePeer = DSH_ACP_PEER.replace(
    "content: { type: 'text', text: 'Hello ' }",
    "content: { type: 'image', data: 'AQ==', mimeType: 'image/png' }"
  )
  expect(imagePeer).not.toBe(DSH_ACP_PEER)
  const lifecycle = vi.fn()
  const items: AgentJournalItemBody[] = []
  const adapter = new DshStructuredSessionAdapter({
    resolveLaunch: async () => ({ command: process.execPath, args: ['-e', imagePeer], cwd }),
    onLifecycleEvent: lifecycle,
    onDispatchSettledLate: () => undefined
  })
  try {
    await adapter.acquire({
      identity: {
        sessionId: 'image-review-session',
        workspaceId: 'folder',
        hostId: 'local',
        agent: 'dsh-acp',
        providerHandle: { kind: 'opaque', agent: 'dsh-acp', value: 'pending' }
      },
      fence: 1,
      spawnToken: 'image-review-token',
      events: {
        appendItem: (_identity, body) => items.push(body),
        appendTombstone: () => undefined,
        publish: () => undefined
      }
    })
    await adapter.dispatch({
      sessionId: 'image-review-session',
      fence: 1,
      clientMessageId: 'image-review-message',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'show it' }] }
    })
    await vi.waitFor(() =>
      expect(
        lifecycle.mock.calls.length > 0 || items.some((item) => item.kind === 'approval')
      ).toBe(true)
    )
    expect(lifecycle.mock.calls).toEqual([])
  } finally {
    await adapter.closeAll()
  }
})
