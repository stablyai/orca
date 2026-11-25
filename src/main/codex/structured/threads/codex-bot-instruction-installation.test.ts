import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import { describe, expect, it, vi } from 'vitest'
import { openTestAgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { CodexAppServerUnsupportedError } from '../../app-server/codex-app-server-session'
import {
  install,
  root,
  SNAPSHOT,
  store,
  reopenInstallationStore
} from './codex-bot-instruction-installation.test-support'

describe('Codex instruction installation in the owning record store', () => {
  it('records pending installation before the RPC and leaves acceptance for the started-handle commit', async () => {
    let recorded: unknown
    const request = vi.fn<CodexAppServerConnection['request']>(async () => {
      recorded = (await openTestAgentSessionRecordStore(root)).getRecord('release-chat')
        ?.instructionPolicy?.state
      return {}
    })
    const { policy: receipt } = await install(request)
    expect(recorded).toBe('pending')
    expect(receipt.state).toBe('delivered')
    expect(store.getRecord('release-chat')?.instructionPolicy?.state).toBe('pending')
    const [method, params] = request.mock.calls[0]!
    expect(method).toBe('thread/inject_items')
    expect(params).toEqual({
      threadId: 'native-release',
      items: [
        {
          type: 'message',
          id: receipt.operationId,
          role: 'developer',
          content: [{ type: 'input_text', text: SNAPSHOT.text }]
        }
      ]
    })
    expect(JSON.stringify(store.getRecord('release-chat')?.instructionPolicy)).not.toContain(
      'Owner approval'
    )
  })

  it('does not append after a successful fresh start', async () => {
    const request = vi.fn<CodexAppServerConnection['request']>(async () => ({}))
    const { policy: receipt } = await install(request, new AbortController().signal, true)
    expect(receipt).toMatchObject({
      state: 'delivered',
      nativeId: 'native-release',
      anchor: 'anchor-1',
      generation: 'generation-1'
    })
    expect(store.getRecord('release-chat')?.instructionPolicy).toBeUndefined()
    expect(request.mock.calls).toEqual([])
  })

  it('keeps uncertainty after cancellation/reopen and never repeats the uncertain installation', async () => {
    const reply = Promise.withResolvers<unknown>()
    const entered = Promise.withResolvers<void>()
    const request = vi.fn(() => {
      entered.resolve()
      return reply.promise
    })
    const abort = new AbortController()
    const installing = install(request, abort.signal)
    await entered.promise
    expect(store.getRecord('release-chat')?.instructionPolicy?.state).toBe('pending')
    abort.abort(new Error('deadline'))
    await expect(installing).rejects.toMatchObject({ fact: { instructionRecovery: 'timeout' } })
    await reopenInstallationStore()
    expect(store.getRecord('release-chat')?.instructionPolicy?.state).toBe('pending')
    const retry = vi.fn(async () => ({}))
    await expect(install(retry)).rejects.toMatchObject({ fact: { instructionRecovery: 'pending' } })
    expect(retry.mock.calls).toEqual([])
    reply.resolve({})
    expect(store.getRecord('release-chat')?.instructionPolicy?.state).toBe('pending')
  })

  it('keeps a possibly mutated RPC failure pending across reopen', async () => {
    await expect(
      install(
        vi.fn(async () => {
          throw new Error('checkpoint failed after append')
        })
      )
    ).rejects.toMatchObject({ fact: { instructionRecovery: 'unknown' } })
    await reopenInstallationStore()
    expect(store.getRecord('release-chat')?.instructionPolicy?.state).toBe('pending')
    await expect(install()).rejects.toMatchObject({ fact: { instructionRecovery: 'pending' } })
  })

  it.each([
    ['thread/inject_items', 'unsupported'],
    ['thread/settings/update', 'unknown']
  ] as const)('classifies a normalized missing %s method as %s', async (method, recovery) => {
    await expect(
      install(async () => {
        throw new CodexAppServerUnsupportedError(`codex app-server does not support ${method}`)
      })
    ).rejects.toMatchObject({ fact: { instructionRecovery: recovery } })
    await reopenInstallationStore()
    expect(store.getRecord('release-chat')?.instructionPolicy?.state).toBe('pending')
  })

  it('does not send instructions when the pending record transaction fails', async () => {
    const transition = vi.spyOn(store, 'updateRecord').mockRejectedValueOnce(new Error('disk full'))
    const request = vi.fn<CodexAppServerConnection['request']>(async () => ({}))
    await expect(install(request)).rejects.toMatchObject({
      fact: { instructionRecovery: 'commit' }
    })
    expect(request.mock.calls).toEqual([])
    expect(store.getRecord('release-chat')?.instructionPolicy).toBeUndefined()
    transition.mockRestore()
  })
})
