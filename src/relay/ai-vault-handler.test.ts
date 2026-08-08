import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult } from '../shared/ai-vault-types'
import { SSH_AI_VAULT_LIST_SESSIONS_METHOD } from '../shared/ssh-ai-vault-relay'
import { getRemoteHostPlatform } from '../main/ssh/ssh-remote-platform'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import { AiVaultHandler } from './ai-vault-handler'

type RequestHandler = (params: Record<string, unknown>, context: RequestContext) => Promise<unknown>

const temporaryHomes: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryHomes.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('AiVaultHandler', () => {
  it('discovers and parses sessions entirely on the relay host', async () => {
    const remoteHome = await makeTemporaryHome()
    const transcriptPath = join(
      remoteHome,
      '.codex',
      'sessions',
      '2026',
      '07',
      '26',
      'rollout-test.jsonl'
    )
    await mkdir(dirname(transcriptPath), { recursive: true })
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: '2026-07-26T01:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'ssh-session', cwd: join(remoteHome, 'repo') }
        }),
        JSON.stringify({
          timestamp: '2026-07-26T01:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Scan on the SSH target' }]
          }
        })
      ].join('\n')
    )
    const dispatcher = createMockDispatcher()
    new AiVaultHandler(dispatcher.value, {
      remoteHome,
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    const result = (await dispatcher.call(SSH_AI_VAULT_LIST_SESSIONS_METHOD, {
      limit: 20
    })) as AiVaultListResult

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      executionHostId: 'local',
      executionHostPlatform: 'linux',
      sessionId: 'ssh-session',
      title: 'Scan on the SSH target',
      filePath: transcriptPath
    })
  })

  it('bounds relay scan parameters before touching the target filesystem', async () => {
    const scanRemoteSessions = vi.fn().mockResolvedValue(emptyResult())
    const dispatcher = createMockDispatcher()
    new AiVaultHandler(dispatcher.value, {
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64'),
      scanRemoteSessions
    })
    const scopePaths = Array.from({ length: 80 }, (_, index) => `/repo/${index}`)

    await dispatcher.call(SSH_AI_VAULT_LIST_SESSIONS_METHOD, {
      limit: 50_000,
      scopePaths
    })

    expect(scanRemoteSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        executionHostId: 'local',
        limit: 1000,
        scopePaths: scopePaths.slice(0, 64)
      })
    )
    const result = (await dispatcher.call(SSH_AI_VAULT_LIST_SESSIONS_METHOD, {
      scopePaths
    })) as AiVaultListResult
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        kind: 'scope',
        message: expect.stringContaining('first 64 project paths')
      })
    )
  })

  it('forwards Unlimited without the relay numeric cap', async () => {
    const scanRemoteSessions = vi.fn().mockResolvedValue(emptyResult())
    const dispatcher = createMockDispatcher()
    new AiVaultHandler(dispatcher.value, {
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64'),
      scanRemoteSessions
    })

    await dispatcher.call(SSH_AI_VAULT_LIST_SESSIONS_METHOD, {
      limit: 50_000,
      unlimited: true
    })

    expect(scanRemoteSessions).toHaveBeenCalledWith(
      expect.objectContaining({ limit: undefined, unlimited: true })
    )
  })

  it('coalesces identical in-flight scans without coupling caller cancellation', async () => {
    let resolveScan: ((result: AiVaultListResult) => void) | undefined
    let sharedSignal: AbortSignal | undefined
    const scanRemoteSessions = vi.fn(
      (args: { signal?: AbortSignal }) =>
        new Promise<AiVaultListResult>((resolve) => {
          sharedSignal = args.signal
          resolveScan = resolve
        })
    )
    const dispatcher = createMockDispatcher()
    new AiVaultHandler(dispatcher.value, {
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64'),
      scanRemoteSessions: scanRemoteSessions as never
    })
    const firstController = new AbortController()
    const first = dispatcher.call(
      SSH_AI_VAULT_LIST_SESSIONS_METHOD,
      { limit: 20 },
      firstController.signal
    )
    const second = dispatcher.call(SSH_AI_VAULT_LIST_SESSIONS_METHOD, { limit: 20 })
    await vi.waitFor(() => expect(scanRemoteSessions).toHaveBeenCalledTimes(1))

    firstController.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(sharedSignal?.aborted).toBe(false)

    resolveScan?.(emptyResult())
    await expect(second).resolves.toEqual(emptyResult())
  })

  it('re-joins a preempted relay caller onto the forced refresh', async () => {
    const signals: AbortSignal[] = []
    let resolveForced: ((result: AiVaultListResult) => void) | undefined
    const scanRemoteSessions = vi.fn((args: { signal: AbortSignal }) => {
      signals.push(args.signal)
      return new Promise<AiVaultListResult>((resolve) => {
        if (signals.length === 1) {
          args.signal.addEventListener('abort', () => resolve(emptyResult()), { once: true })
        } else {
          resolveForced = resolve
        }
      })
    })
    const dispatcher = createMockDispatcher()
    new AiVaultHandler(dispatcher.value, {
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64'),
      scanRemoteSessions: scanRemoteSessions as never
    })
    const first = dispatcher.call(SSH_AI_VAULT_LIST_SESSIONS_METHOD, { limit: 20 })
    await vi.waitFor(() => expect(signals).toHaveLength(1))

    const forced = dispatcher.call(SSH_AI_VAULT_LIST_SESSIONS_METHOD, {
      limit: 20,
      force: true
    })
    await vi.waitFor(() => expect(signals).toHaveLength(2))

    expect(signals[0]?.aborted).toBe(true)
    resolveForced?.(emptyResult())
    // The desktop caller that did not ask for a refresh still gets sessions.
    await expect(Promise.all([first, forced])).resolves.toEqual([emptyResult(), emptyResult()])
  })

  it('soft-disables the method instead of aborting relay startup on an unsupported platform', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true })
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const dispatcher = createMockDispatcher()

      expect(() => new AiVaultHandler(dispatcher.value)).not.toThrow()

      expect(() => dispatcher.call(SSH_AI_VAULT_LIST_SESSIONS_METHOD, {})).toThrow(/No handler/)
    } finally {
      stderr.mockRestore()
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('stops a relay-local scan when the owning request is cancelled', async () => {
    const dispatcher = createMockDispatcher()
    new AiVaultHandler(dispatcher.value, {
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })
    const controller = new AbortController()
    controller.abort()

    await expect(
      dispatcher.call(SSH_AI_VAULT_LIST_SESSIONS_METHOD, {}, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

async function makeTemporaryHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'orca-relay-ai-vault-'))
  temporaryHomes.push(path)
  return path
}

function emptyResult(): AiVaultListResult {
  return { sessions: [], issues: [], scannedAt: '2026-07-26T00:00:00.000Z' }
}

function createMockDispatcher(): {
  value: RelayDispatcher
  call: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
} {
  const handlers = new Map<string, RequestHandler>()
  const value = {
    onRequest(method: string, handler: RequestHandler) {
      handlers.set(method, handler)
    }
  } as RelayDispatcher
  return {
    value,
    call(method, params, signal) {
      const handler = handlers.get(method)
      if (!handler) {
        throw new Error(`No handler for ${method}`)
      }
      return handler(params, {
        clientId: 1,
        isStale: () => signal?.aborted ?? false,
        signal
      })
    }
  }
}
