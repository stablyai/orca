import { vi } from 'vitest'
import type { Mock } from 'vitest'
import * as ptyShellUtils from './pty-shell-utils'
import { PtyHandler } from './pty-handler'
import type { RelayDispatcher } from './dispatcher'

export type TestRequestContext = {
  isStale: () => boolean
  signal?: AbortSignal
}

export function createMockDispatcher() {
  const requestHandlers = new Map<
    string,
    (params: Record<string, unknown>, context?: TestRequestContext) => Promise<unknown>
  >()
  const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>()
  const notifications: { method: string; params?: Record<string, unknown> }[] = []

  const dispatcher = {
    onRequest: vi.fn(
      (
        method: string,
        handler: (params: Record<string, unknown>, context?: TestRequestContext) => Promise<unknown>
      ) => {
        requestHandlers.set(method, handler)
      }
    ),
    onNotification: vi.fn((method: string, handler: (params: Record<string, unknown>) => void) => {
      notificationHandlers.set(method, handler)
    }),
    notify: vi.fn((method: string, params?: Record<string, unknown>) => {
      notifications.push({ method, params })
    }),
    // Helpers for tests
    _requestHandlers: requestHandlers,
    _notificationHandlers: notificationHandlers,
    _notifications: notifications,
    async callRequest(
      method: string,
      params: Record<string, unknown> = {},
      context?: TestRequestContext
    ) {
      const handler = requestHandlers.get(method)
      if (!handler) {
        throw new Error(`No handler for ${method}`)
      }
      return handler(params, context)
    },
    callNotification(method: string, params: Record<string, unknown> = {}) {
      const handler = notificationHandlers.get(method)
      if (!handler) {
        throw new Error(`No handler for ${method}`)
      }
      handler(params)
    }
  }

  return dispatcher
}

export type MockDispatcher = ReturnType<typeof createMockDispatcher>

type MockPtyInstance = {
  pid: number
  onData: Mock
  onExit: Mock
  write: Mock
  resize: Mock
  kill: Mock
  clear: Mock
  pause: Mock
  resume: Mock
}

export type PtyHandlerTestMocks = {
  mockPtySpawn: Mock
  mockPtyInstance: MockPtyInstance
  mockCreateShellPromptReadinessProbe: Mock
}

/** Mirrors the shared beforeEach: pin the platform, reset node-pty mocks, build handler + dispatcher. */
export function beginPtyHandlerTest(mocks: PtyHandlerTestMocks): {
  dispatcher: MockDispatcher
  handler: PtyHandler
  originalPlatform: PropertyDescriptor | undefined
} {
  const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = mocks
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  vi.useFakeTimers()
  mockPtySpawn.mockReset()
  mockPtyInstance.onData.mockReset()
  mockPtyInstance.onExit.mockReset()
  mockPtyInstance.write.mockReset()
  mockPtyInstance.resize.mockReset()
  mockPtyInstance.kill.mockReset()
  mockPtyInstance.clear.mockReset()
  mockPtyInstance.pause.mockReset()
  mockPtyInstance.resume.mockReset()
  mockCreateShellPromptReadinessProbe.mockReset()
  mockCreateShellPromptReadinessProbe.mockReturnValue({
    notifyOutput: vi.fn(),
    dispose: vi.fn()
  })
  vi.spyOn(ptyShellUtils, 'processHasChildren').mockResolvedValue(false)

  mockPtySpawn.mockReturnValue({ ...mockPtyInstance })

  const dispatcher = createMockDispatcher()
  const handler = new PtyHandler(dispatcher as unknown as RelayDispatcher)
  return { dispatcher, handler, originalPlatform }
}

export async function endPtyHandlerTest(
  handler: PtyHandler,
  originalPlatform: PropertyDescriptor | undefined
): Promise<void> {
  const cleanup = handler.dispose({ waitForPhysicalExit: false })
  await vi.runAllTimersAsync()
  await cleanup.catch(() => {})
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
}

/** Reads the dispatcher lazily so tests that swap in a fresh dispatcher keep working. */
export function createPtyRequestHelpers(getDispatcher: () => MockDispatcher) {
  async function spawnPty(
    params: Record<string, unknown> = {}
  ): Promise<{ id: string; incarnationId: string }> {
    return (await getDispatcher().callRequest('pty.spawn', params)) as {
      id: string
      incarnationId: string
    }
  }

  async function attachPty(
    params: Record<string, unknown>
  ): Promise<{ incarnationId: string; replay?: string }> {
    return (await getDispatcher().callRequest('pty.attach', params)) as {
      incarnationId: string
      replay?: string
    }
  }

  return { spawnPty, attachPty }
}
