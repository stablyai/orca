import type { IPtyProvider, PtySpawnOptions } from '../pty/provider-contract'
import type { RexFreshSession } from './rex-fresh-session'
const supported = new Set([
  'cols',
  'rows',
  'cwd',
  'isNewSession',
  'env',
  'envToDelete',
  'terminalShellArgs',
  'sessionId',
  'worktreeId',
  'paneKey',
  'tabId',
  'prevalidatedCwd',
  'signal',
  'onPtySpawnCommitted',
  'historyIsolationEnabled',
  'startupIngress',
  'shellOverride',
  'spawnIntent'
])

export function validateRexFreshLaunch(opts: PtySpawnOptions): void {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('Rex requires a supported POSIX host')
  }
  if (Object.entries(opts).some(([key, value]) => !supported.has(key) && value !== undefined)) {
    throw new Error('Unsupported Rex spawn option')
  }
  if (
    opts.startupIngress?.launcherAttributes ||
    (opts.spawnIntent && opts.spawnIntent !== 'interactive')
  ) {
    throw new Error('Rex launch requires unsupported launcher attributes or restore semantics')
  }
  if (opts.isNewSession === false) {
    throw new Error('Rex fresh spawn requires a new interactive shell')
  }
  if (
    opts.terminalShellArgs?.some(
      (arg) =>
        ![
          '-i',
          '-l',
          '-il',
          '-li',
          '--login',
          '--interactive',
          '--noprofile',
          '--norc',
          '-f',
          '--no-config'
        ].includes(arg)
    )
  ) {
    throw new Error('Unsupported Rex interactive shell arguments')
  }
  if (opts.sessionId && opts.isNewSession !== true) {
    throw new Error('Rex fresh spawn requires an explicit new identity')
  }
}

export function validateRexShutdown(
  session: RexFreshSession,
  opts: Parameters<IPtyProvider['shutdown']>[1]
): void {
  if (
    (opts.expectedIncarnationId && opts.expectedIncarnationId !== session.record.incarnationId) ||
    opts.expectedOwnerClientInstanceId ||
    opts.keepHistory
  ) {
    throw new Error('Unsupported Rex termination fence or history request')
  }
  if (opts.deadlineMs !== undefined && opts.deadlineMs < Date.now() + 5000) {
    throw new Error('Insufficient Rex termination budget')
  }
}

export function checkRexSize(cols: number, rows: number): void {
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 1 ||
    rows < 1 ||
    cols > 1000 ||
    rows > 1000
  ) {
    throw new Error('Invalid Rex grid')
  }
}
