import type { Mock } from 'vitest'
import type * as BoundedFileReader from '../../shared/node-bounded-file-reader'

type MockFn = Mock

export type GitRunnerMocks = {
  gitExecFileAsyncMock: MockFn
  gitExecFileAsyncBufferMock: MockFn
  gitStreamOptionsMock: MockFn
}

export type FsPromisesMocks = {
  lstatMock: MockFn
  realpathMock: MockFn
  readFileMock: MockFn
  statMock: MockFn
  rmMock: MockFn
  /** Optional: defaults to "nothing exists", which is what most git-read tests assume. */
  accessMock?: MockFn
}

export function createGitRunnerModuleMock(mocks: GitRunnerMocks): Record<string, unknown> {
  return {
    gitExecFileAsync: mocks.gitExecFileAsyncMock,
    gitExecFileAsyncBuffer: mocks.gitExecFileAsyncBufferMock,
    // Feed queued exec responses into the status stream, preserving existing argv-based mocks.
    gitStreamStdout: async (
      args: string[],
      options: { signal?: AbortSignal; onStdout: (chunk: string) => boolean | void }
    ) => {
      mocks.gitStreamOptionsMock(options)
      const { stdout } = await mocks.gitExecFileAsyncMock(args)
      const stoppedEarly = options.onStdout(stdout ?? '') === true
      return { stoppedEarly }
    },
    gitOptionalLocksDisabledEnv: (env: NodeJS.ProcessEnv = process.env) => ({
      ...env,
      GIT_OPTIONAL_LOCKS: '0'
    })
  }
}

export function createFsPromisesModuleMock(mocks: FsPromisesMocks): Record<string, unknown> {
  return {
    lstat: mocks.lstatMock,
    realpath: mocks.realpathMock,
    readFile: mocks.readFileMock,
    stat: mocks.statMock,
    rm: mocks.rmMock,
    access:
      mocks.accessMock ??
      (async (target: string) => {
        throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' })
      })
  }
}

export function createBoundedFileReaderModuleMock(
  actual: typeof BoundedFileReader,
  mocks: { readFileMock: MockFn; statMock: MockFn }
): Record<string, unknown> {
  return {
    ...actual,
    readNodeFileWithinLimit: async (filePath: string, maxBytes: number) => {
      if (maxBytes === 64 * 1024) {
        const value = await mocks.readFileMock(filePath)
        const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
        if (buffer.length > maxBytes) {
          throw new actual.NodeFileReadTooLargeError(buffer.length, maxBytes)
        }
        return { buffer, stats: { isFile: () => true, size: buffer.length } }
      }
      const stats = await mocks.statMock(filePath)
      if (stats.size > maxBytes) {
        throw new actual.NodeFileReadTooLargeError(stats.size, maxBytes)
      }
      const value = await mocks.readFileMock(filePath)
      const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
      if (buffer.length > maxBytes) {
        throw new actual.NodeFileReadTooLargeError(buffer.length, maxBytes)
      }
      return { buffer, stats }
    }
  }
}
