import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { dispatchClaudeTurn } from './claude-structured-dispatch'
import type { ClaudeJournalTranslator } from './claude-structured-journal-translation'
import { createClaudeSessionTerminal, type ClaudeSession } from './claude-structured-session-state'

function translatorSpies() {
  return {
    registerOwnedTurn: vi.fn(),
    confirmOwnedTurn: vi.fn(),
    settleOwnedTurn: vi.fn(),
    abandonOwnedTurn: vi.fn()
  }
}

function sessionFor(
  send = vi.fn().mockResolvedValue(undefined),
  translator = translatorSpies()
): ClaudeSession {
  return {
    connection: { send } as unknown as ClaudeSession['connection'],
    providerSessionId: 'provider-session',
    leafUuid: null,
    fence: 1,
    prompts: {} as ClaudeSession['prompts'],
    generation: {},
    sentUserUuidSequence: new Map(),
    deliveryEvidenceUuids: new Set(),
    dispatchLane: Promise.resolve(),
    dispatchFenced: false,
    terminal: createClaudeSessionTerminal(),
    options: new Map(),
    reportedOptions: {},
    events: undefined,
    translator: translator as unknown as ClaudeJournalTranslator
  }
}

function userMessage(blocks: AgentJournalMessageItem['blocks']): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks }
}

function deferred() {
  let resolve = (): void => {}
  let reject = (_error: Error): void => {}
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('Claude structured dispatch', () => {
  it('registers a caller UUID before writing and accepts that identity after the write', async () => {
    const translator = translatorSpies()
    let session!: ClaudeSession
    const send = vi.fn(async (message: Record<string, unknown>) => {
      const uuid = message.uuid as string
      expect(session.sentUserUuidSequence.get(uuid)).toBe(0)
      expect(translator.registerOwnedTurn).toHaveBeenCalledWith('provider-session', uuid, 0)
    })
    session = sessionFor(send, translator)

    const result = await dispatchClaudeTurn(session, {
      clientMessageId: 'client-1',
      body: userMessage([{ type: 'text', text: 'hello' }])
    })
    const sentUuid = send.mock.calls[0]![0].uuid as string

    expect(result).toEqual({
      state: 'accepted',
      providerIdentity: { provider: 'claude', sessionId: 'provider-session', uuid: sentUuid }
    })
    expect(translator.confirmOwnedTurn).toHaveBeenCalledWith(sentUuid)
  })

  it('keeps concurrent dispatch identities in registration order', async () => {
    const session = sessionFor()

    const [first, second] = await Promise.all([
      dispatchClaudeTurn(session, {
        clientMessageId: 'client-1',
        body: userMessage([{ type: 'text', text: 'one' }])
      }),
      dispatchClaudeTurn(session, {
        clientMessageId: 'client-2',
        body: userMessage([{ type: 'text', text: 'two' }])
      })
    ])
    const entries = [...session.sentUserUuidSequence]

    expect(entries.map((entry) => entry[1])).toEqual([0, 1])
    expect(first).toMatchObject({ providerIdentity: { uuid: entries[0]![0] } })
    expect(second).toMatchObject({ providerIdentity: { uuid: entries[1]![0] } })
  })

  it('keeps acceptance when the exact echo arrives before the write rejects', async () => {
    const translator = translatorSpies()
    let session!: ClaudeSession
    const send = vi.fn(async (message: Record<string, unknown>) => {
      const uuid = message.uuid as string
      session.deliveryEvidenceUuids.add(uuid)
      translator.confirmOwnedTurn(uuid)
      throw new Error('flush failed')
    })
    session = sessionFor(send, translator)

    const result = await dispatchClaudeTurn(session, {
      clientMessageId: 'client-1',
      body: userMessage([{ type: 'text', text: 'hello' }])
    })
    const sentUuid = send.mock.calls[0]![0].uuid as string

    expect(result).toMatchObject({ state: 'accepted', providerIdentity: { uuid: sentUuid } })
    expect(session.dispatchFenced).toBe(false)
    expect(translator.abandonOwnedTurn).not.toHaveBeenCalled()
  })

  it('fences later dispatches after an unobserved write failure', async () => {
    const translator = translatorSpies()
    const send = vi.fn().mockRejectedValueOnce(new Error('broken pipe'))
    const session = sessionFor(send, translator)

    await expect(
      dispatchClaudeTurn(session, {
        clientMessageId: 'client-1',
        body: userMessage([{ type: 'text', text: 'one' }])
      })
    ).resolves.toEqual({ state: 'unknown', reason: 'broken pipe' })
    const sentUuid = send.mock.calls[0]![0].uuid as string
    expect(translator.abandonOwnedTurn).toHaveBeenCalledWith(sentUuid)

    await expect(
      dispatchClaudeTurn(session, {
        clientMessageId: 'client-2',
        body: userMessage([{ type: 'text', text: 'two' }])
      })
    ).resolves.toMatchObject({ state: 'unknown' })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not materialize a queued dispatch after the active write becomes uncertain', async () => {
    const pendingWrite = deferred()
    const send = vi.fn().mockImplementationOnce(() => pendingWrite.promise)
    const session = sessionFor(send)
    const first = dispatchClaudeTurn(session, {
      clientMessageId: 'client-1',
      body: userMessage([{ type: 'text', text: 'one' }])
    })
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const second = dispatchClaudeTurn(session, {
      clientMessageId: 'client-2',
      body: userMessage([])
    })

    pendingWrite.reject(new Error('broken pipe'))

    await expect(first).resolves.toEqual({ state: 'unknown', reason: 'broken pipe' })
    await expect(second).resolves.toMatchObject({
      state: 'unknown',
      reason: 'claude delivery is uncertain until the session reconnects'
    })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('releases the dispatch lane after local validation fails', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const session = sessionFor(send)

    const [first, second] = await Promise.all([
      dispatchClaudeTurn(session, {
        clientMessageId: 'client-1',
        body: userMessage([])
      }),
      dispatchClaudeTurn(session, {
        clientMessageId: 'client-2',
        body: userMessage([{ type: 'text', text: 'two' }])
      })
    ])

    expect(first).toEqual({
      state: 'rejected',
      reason: 'Claude dispatch requires text or an image'
    })
    expect(second).toMatchObject({ state: 'accepted' })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('wakes active and queued dispatches when the session becomes terminal', async () => {
    const pendingWrite = deferred()
    const send = vi.fn().mockImplementationOnce(() => pendingWrite.promise)
    const session = sessionFor(send)
    const first = dispatchClaudeTurn(session, {
      clientMessageId: 'client-1',
      body: userMessage([{ type: 'text', text: 'one' }])
    })
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const second = dispatchClaudeTurn(session, {
      clientMessageId: 'client-2',
      body: userMessage([{ type: 'text', text: 'two' }])
    })

    session.terminal.close()

    await expect(first).resolves.toEqual({
      state: 'unknown',
      reason: 'claude session closed while delivery was pending'
    })
    await expect(second).resolves.toEqual({
      state: 'rejected',
      reason: 'claude structured session closed before dispatch'
    })
    expect(send).toHaveBeenCalledTimes(1)
    pendingWrite.resolve()
  })

  it('accepts image-only content under the UUID written to stdin', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-claude-dispatch-'))
    try {
      const path = join(directory, 'pixel.png')
      await writeFile(path, Buffer.from([0, 1, 2]))
      const session = sessionFor()

      const result = await dispatchClaudeTurn(session, {
        clientMessageId: 'client-image',
        body: userMessage([{ type: 'image-ref', path }])
      })
      const sent = vi.mocked(session.connection.send).mock.calls[0]![0]

      expect(result).toMatchObject({ state: 'accepted', providerIdentity: { uuid: sent.uuid } })
      expect(sent).toMatchObject({
        message: {
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'AAEC' }
            }
          ]
        }
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects more than twenty URL images before sending', async () => {
    const session = sessionFor()
    const body = userMessage(
      Array.from({ length: 21 }, (_, index) => ({
        type: 'image-ref' as const,
        url: `https://example.test/${index}.png`
      }))
    )

    await expect(
      dispatchClaudeTurn(session, { clientMessageId: 'client-1', body })
    ).resolves.toEqual({ state: 'rejected', reason: 'Claude messages support at most 20 images' })
    expect(session.connection.send).not.toHaveBeenCalled()
  })

  it('rejects local images whose aggregate size exceeds twenty MiB', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-claude-images-'))
    try {
      const paths = await Promise.all(
        Array.from({ length: 5 }, async (_, index) => {
          const path = join(directory, `${index}.png`)
          await writeFile(path, Buffer.alloc(5 * 1024 * 1024))
          return path
        })
      )
      const session = sessionFor()
      const body = userMessage(paths.map((path) => ({ type: 'image-ref' as const, path })))

      await expect(
        dispatchClaudeTurn(session, { clientMessageId: 'client-1', body })
      ).resolves.toEqual({
        state: 'rejected',
        reason: `Claude images must total no more than ${20 * 1024 * 1024} bytes`
      })
      expect(session.connection.send).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a local image by actual bytes read beyond the per-image cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-claude-image-'))
    try {
      const path = join(directory, 'oversized.png')
      await writeFile(path, Buffer.alloc(5 * 1024 * 1024 + 1))
      const session = sessionFor()
      const body = userMessage([{ type: 'image-ref', path }])

      await expect(
        dispatchClaudeTurn(session, { clientMessageId: 'client-1', body })
      ).resolves.toEqual({
        state: 'rejected',
        reason: `Claude image must be a non-empty file no larger than ${5 * 1024 * 1024} bytes`
      })
      expect(session.connection.send).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
