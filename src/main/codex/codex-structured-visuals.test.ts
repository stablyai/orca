import { describe, expect, it, vi } from 'vitest'
import {
  NATIVE_CHAT_VISUALS_DIR_ENV,
  type NativeChatVisualsLaunch
} from '../native-chat/native-chat-visuals-delivery'
import { CodexAppServerRequestError } from './codex-app-server-request-error'
import { CodexAppServerTimeoutError } from './codex-app-server-session'
import { acquired, fakeCodex, THREAD_ID } from './codex-structured-session-adapter-fixture'
import {
  CODEX_VISUALS_SETUP_BUDGET_MS,
  prepareCodexThreadForVisuals
} from './codex-structured-visuals'

const VISUALS: NativeChatVisualsLaunch = {
  folder: '/state/native-chat-visuals/abc',
  skill: { pluginDir: '/app/native-chat-visuals', skillsRoot: '/app/native-chat-visuals/skills' }
}
const MANUAL = { approvalPolicy: 'on-request', sandbox: 'workspace-write' } as const
const YOLO = { approvalPolicy: 'never', sandbox: 'danger-full-access' } as const

type Call = { method: string; params?: Record<string, unknown>; timeoutMs?: number }

function connectionAnswering(routes: Record<string, () => unknown>) {
  const calls: Call[] = []
  const request = vi.fn(
    async (method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }) => {
      calls.push({ method, params, timeoutMs: options?.timeoutMs })
      const route = routes[method]
      return route ? route() : {}
    }
  )
  return { calls, connection: { request } }
}

const configWithRoots = (roots: unknown) => () => ({
  config: { sandbox_workspace_write: { writable_roots: roots, network_access: true } }
})

describe('setting up a Codex app-server for a chat with visuals', () => {
  it("names the skill root and adds the chat folder to the user's writable roots", async () => {
    const { calls, connection } = connectionAnswering({
      'config/read': configWithRoots(['/home/me/scratch'])
    })
    const config = await prepareCodexThreadForVisuals(connection, {
      cwd: '/work/repo',
      visuals: VISUALS,
      permissionPolicy: MANUAL
    })
    expect(config).toEqual({
      'sandbox_workspace_write.writable_roots': ['/home/me/scratch', VISUALS.folder]
    })
    expect(calls).toEqual(
      expect.arrayContaining([
        {
          method: 'skills/extraRoots/set',
          params: { extraRoots: [VISUALS.skill.skillsRoot] },
          timeoutMs: CODEX_VISUALS_SETUP_BUDGET_MS
        },
        {
          method: 'config/read',
          params: { cwd: '/work/repo' },
          timeoutMs: CODEX_VISUALS_SETUP_BUDGET_MS
        }
      ])
    )
  })

  it('grants just the folder when the user has no writable roots of their own', async () => {
    for (const answer of [() => ({ config: {} }), configWithRoots([])]) {
      const { connection } = connectionAnswering({ 'config/read': answer })
      await expect(
        prepareCodexThreadForVisuals(connection, { cwd: '/w', visuals: VISUALS })
      ).resolves.toEqual({ 'sandbox_workspace_write.writable_roots': [VISUALS.folder] })
    }
  })

  it('overrides nothing when the user roots cannot be read, so none are dropped', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() }
    for (const route of [
      () => Promise.reject(new CodexAppServerTimeoutError('config/read exceeded 2000ms')),
      configWithRoots([42]),
      () => ({ nothing: true })
    ]) {
      const { connection } = connectionAnswering({ 'config/read': route })
      await expect(
        prepareCodexThreadForVisuals(
          connection,
          { cwd: '/w', visuals: VISUALS, permissionPolicy: MANUAL },
          { logger, sessionId: 's-1' }
        )
      ).resolves.toBeNull()
    }
    expect(logger.warn).toHaveBeenCalledTimes(3)
  })

  it('asks for no writable root under full access, and still names the skill root', async () => {
    const { calls, connection } = connectionAnswering({})
    await expect(
      prepareCodexThreadForVisuals(connection, {
        cwd: '/w',
        visuals: VISUALS,
        permissionPolicy: YOLO
      })
    ).resolves.toBeNull()
    expect(calls.map((call) => call.method)).toEqual(['skills/extraRoots/set'])
  })

  it('opens without the skill on a Codex that predates skill roots, or one that fails or hangs', async () => {
    const failures = [
      new CodexAppServerRequestError(
        'skills/extraRoots/set',
        -32600,
        'Invalid request: unknown variant `skills/extraRoots/set`, expected one of `initialize`'
      ),
      new CodexAppServerRequestError('skills/extraRoots/set', -32601, 'method not found'),
      new CodexAppServerTimeoutError('codex app-server skills/extraRoots/set exceeded 2000ms'),
      new Error('broken pipe')
    ]
    for (const failure of failures) {
      const logger = { warn: vi.fn(), error: vi.fn() }
      const { connection } = connectionAnswering({
        'skills/extraRoots/set': () => Promise.reject(failure),
        'config/read': configWithRoots([])
      })
      await expect(
        prepareCodexThreadForVisuals(
          connection,
          { cwd: '/w', visuals: VISUALS },
          { logger, sessionId: 's-1' }
        )
      ).resolves.toEqual({ 'sandbox_workspace_write.writable_roots': [VISUALS.folder] })
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(
          failure.message.includes('variant') || failure.message.includes('not found')
            ? /cannot load skills/
            : /did not take/
        ),
        expect.objectContaining({ scope: 'nativeChatVisuals.codex', error: failure })
      )
    }
  })

  it('sends nothing for a chat without visuals', async () => {
    const { calls, connection } = connectionAnswering({})
    await expect(prepareCodexThreadForVisuals(connection, { cwd: '/w' })).resolves.toBeNull()
    expect(calls).toEqual([])
  })
})

describe('a Codex chat acquisition with visuals', () => {
  it('sets up skills and the folder after initialize and before the thread opens, on start and resume', async () => {
    for (const resumeThreadId of [null, THREAD_ID]) {
      const codex = fakeCodex({ 'config/read': configWithRoots(['/home/me/scratch']) })
      await acquired(codex, { visuals: VISUALS, permissionPolicy: MANUAL, resumeThreadId })
      const connection = codex.connections[0]!
      const methods = connection.calls.map((call) => call.method)
      const open = resumeThreadId ? 'thread/resume' : 'thread/start'
      expect(methods[0]).toBe('initialize')
      expect(methods.indexOf('skills/extraRoots/set')).toBeLessThan(methods.indexOf(open))
      expect(methods.indexOf('config/read')).toBeLessThan(methods.indexOf(open))
      expect(connection.calls.find((call) => call.method === open)?.params).toMatchObject({
        ...MANUAL,
        config: { 'sandbox_workspace_write.writable_roots': ['/home/me/scratch', VISUALS.folder] }
      })
      expect(connection.launch.env?.[NATIVE_CHAT_VISUALS_DIR_ENV]).toBe(VISUALS.folder)
    }
  })

  it('opens the thread exactly as before for a chat without visuals', async () => {
    const codex = fakeCodex()
    await acquired(codex, {
      permissionPolicy: MANUAL,
      env: { [NATIVE_CHAT_VISUALS_DIR_ENV]: '/other' }
    })
    const connection = codex.connections[0]!
    const methods = connection.calls.map((call) => call.method)
    // The adapter sends `initialize` itself now; nothing comes between it and the thread.
    expect(methods.slice(0, 2)).toEqual(['initialize', 'thread/start'])
    expect(methods).not.toContain('skills/extraRoots/set')
    expect(connection.calls[1]?.params).not.toHaveProperty('config')
    expect(connection.launch.env).not.toHaveProperty(NATIVE_CHAT_VISUALS_DIR_ENV)
  })
})
