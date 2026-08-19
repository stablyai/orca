/**
 * Shared per-test scaffolding for the GitHandler relay suites: a throwaway repo
 * directory, a GitHandler bound to a mock dispatcher, and the spy-target shapes
 * used to stub the handler's private git runners.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { GitHandler } from './git-handler'
import { RelayContext } from './context'
import {
  createMockDispatcher,
  type MockDispatcher,
  type RelayDispatcher
} from './git-handler-test-setup'

export type GitBufferSpyTarget = {
  gitBuffer(args: string[], cwd: string): Promise<Buffer>
}

export type GitSpyTarget = {
  git(
    args: string[],
    cwd: string,
    opts?: { signal?: AbortSignal }
  ): Promise<{ stdout: string; stderr: string }>
}

export function createGitTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'relay-git-'))
}

export async function removeGitTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

export function createGitHandlerRelay(): { dispatcher: MockDispatcher; handler: GitHandler } {
  const dispatcher = createMockDispatcher()
  const ctx = new RelayContext()
  const handler = new GitHandler(dispatcher as unknown as RelayDispatcher, ctx)
  return { dispatcher, handler }
}

export function normalizeGitFileText(content: string): string {
  return content.replace(/\r\n/g, '\n')
}
