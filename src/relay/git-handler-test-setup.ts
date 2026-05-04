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

// Why: declare an explicit type so the inferred return type of
// createMockDispatcher doesn't transitively reference `@vitest/spy`'s
// internal `Procedure` type (from `vi.fn(...)`). Without this annotation,
// TS2883 fires under `pnpm run tc:node` because the generated .d.ts would
// need to name a type that isn't portably resolvable from this module.
export type MockDispatcher = {
  onRequest: (
    method: string,
    handler: (
      params: Record<string, unknown>,
      context: { isStale: () => boolean }
    ) => Promise<unknown>
  ) => void
  onNotification: (method: string, handler: (params: Record<string, unknown>) => void) => void
  notify: (method: string, params?: Record<string, unknown>) => void
  _requestHandlers: Map<
    string,
    (params: Record<string, unknown>, context: { isStale: () => boolean }) => Promise<unknown>
  >
  callRequest(method: string, params?: Record<string, unknown>): Promise<unknown>
}

export function createMockDispatcher(): MockDispatcher {
  const requestHandlers = new Map<
    string,
    (params: Record<string, unknown>, context: { isStale: () => boolean }) => Promise<unknown>
  >()

  return {
    onRequest: vi.fn(
      (
        method: string,
        handler: (
          params: Record<string, unknown>,
          context: { isStale: () => boolean }
        ) => Promise<unknown>
      ) => {
        requestHandlers.set(method, handler)
      }
    ),
    onNotification: vi.fn(),
    notify: vi.fn(),
    _requestHandlers: requestHandlers,
    async callRequest(method: string, params: Record<string, unknown> = {}) {
      const handler = requestHandlers.get(method)
      if (!handler) {
        throw new Error(`No handler for ${method}`)
      }
      return handler(params, { isStale: () => false })
    }
  }
}

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
