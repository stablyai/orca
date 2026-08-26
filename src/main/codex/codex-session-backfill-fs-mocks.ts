import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'

// Fault-injection doubles for the backfill tests. Kept out of the spec files so
// several suites can drive the same failure modes from one switchboard.

export const fsMockState = {
  failLink: false,
  failLinkTransiently: false,
  failLinkPermission: false,
  raceTargetIntoExistence: false,
  failMarkerRm: false,
  failMarkerReplacement: false,
  failAuditMkdirOnce: false,
  failAuditWrites: false,
  failMkdirPath: null as string | null,
  failDirectoryPath: null as string | null,
  failLstatPath: null as string | null
}

export function resetCodexSessionBackfillFsMocks(): void {
  fsMockState.failLink = false
  fsMockState.failLinkTransiently = false
  fsMockState.failLinkPermission = false
  fsMockState.raceTargetIntoExistence = false
  fsMockState.failMarkerRm = false
  fsMockState.failMarkerReplacement = false
  fsMockState.failAuditMkdirOnce = false
  fsMockState.failAuditWrites = false
  fsMockState.failMkdirPath = null
  fsMockState.failDirectoryPath = null
  fsMockState.failLstatPath = null
}

function errnoError(message: string, code: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException
  error.code = code
  return error
}

function isMarkerPath(value: unknown): boolean {
  return (
    String(value).includes('codex-session-backfill') &&
    String(value).endsWith('backfill-complete.json')
  )
}

export function createNodeFsMock(actual: typeof NodeFs): typeof NodeFs {
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof actual.existsSync>) =>
      args[0] === fsMockState.failLstatPath ? false : actual.existsSync(...args),
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (fsMockState.failMarkerRm && isMarkerPath(args[0])) {
        throw errnoError('EACCES: marker removal failed', 'EACCES')
      }
      return actual.rmSync(...args)
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (fsMockState.failMarkerReplacement && isMarkerPath(args[1])) {
        throw errnoError('EACCES: marker replacement failed', 'EACCES')
      }
      return actual.renameSync(...args)
    }
  }
}

export function createNodeFsPromisesMock(actual: typeof NodeFsPromises): typeof NodeFsPromises {
  return {
    ...actual,
    mkdir: (...args: Parameters<typeof actual.mkdir>) => {
      if (args[0] === fsMockState.failMkdirPath) {
        throw errnoError('EACCES: target directory inaccessible', 'EACCES')
      }
      if (fsMockState.failAuditMkdirOnce && String(args[0]).includes('codex-session-backfill')) {
        fsMockState.failAuditMkdirOnce = false
        throw errnoError('EACCES: transient audit directory failure', 'EACCES')
      }
      return actual.mkdir(...args)
    },
    appendFile: (...args: Parameters<typeof actual.appendFile>) => {
      if (fsMockState.failAuditWrites && String(args[0]).includes('codex-session-backfill')) {
        throw errnoError('ENOSPC: audit write failed', 'ENOSPC')
      }
      return actual.appendFile(...args)
    },
    lstat: (...args: Parameters<typeof actual.lstat>) => {
      if (args[0] === fsMockState.failLstatPath) {
        throw errnoError('EACCES: path inaccessible', 'EACCES')
      }
      return actual.lstat(...args)
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      if (fsMockState.raceTargetIntoExistence && String(args[0]).includes('codex-runtime-home')) {
        fsMockState.raceTargetIntoExistence = false
        await actual.writeFile(args[1], 'concurrent target\n', 'utf-8')
        throw errnoError('EEXIST: concurrent target', 'EEXIST')
      }
      if (fsMockState.failLink && String(args[0]).includes('codex-runtime-home')) {
        throw errnoError('EXDEV: cross-device link', 'EXDEV')
      }
      if (fsMockState.failLinkTransiently && String(args[0]).includes('codex-runtime-home')) {
        throw errnoError('EIO: transient hardlink failure', 'EIO')
      }
      if (fsMockState.failLinkPermission && String(args[0]).includes('codex-runtime-home')) {
        throw errnoError('EACCES: hardlink permission denied', 'EACCES')
      }
      return actual.link(...args)
    },
    opendir: (...args: Parameters<typeof actual.opendir>) => {
      if (args[0] === fsMockState.failDirectoryPath) {
        throw errnoError('EACCES: directory unreadable', 'EACCES')
      }
      return actual.opendir(...args)
    }
  } as typeof NodeFsPromises
}
