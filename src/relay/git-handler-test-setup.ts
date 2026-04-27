/**
 * Shared test utilities for git-handler tests.
 *
 * Why: oxlint max-lines (300) requires splitting large test suites.
 * This module exports the mock dispatcher factory and git helpers
 * so multiple test files can reuse them without duplication.
 */
import { vi } from 'vitest'
import { execFileSync } from 'child_process'
import type { RelayDispatcher } from './dispatcher'

export function createMockDispatcher() {
  const requestHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
  const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>()

  return {
    onRequest: vi.fn(
      (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
        requestHandlers.set(method, handler)
      }
    ),
    onNotification: vi.fn((method: string, handler: (params: Record<string, unknown>) => void) => {
      notificationHandlers.set(method, handler)
    }),
    notify: vi.fn(),
    _requestHandlers: requestHandlers,
    async callRequest(method: string, params: Record<string, unknown> = {}) {
      const handler = requestHandlers.get(method)
      if (!handler) {
        throw new Error(`No handler for ${method}`)
      }
      return handler(params)
    }
  }
}

export type MockDispatcher = ReturnType<typeof createMockDispatcher>

export function gitInit(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' })
}

export function gitCommit(dir: string, message: string): void {
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', message, '--allow-empty'], { cwd: dir, stdio: 'pipe' })
}

export type { RelayDispatcher }
