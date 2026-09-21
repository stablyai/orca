'use strict'

const NODE_PTY_JOB_EXPORTS = ['listJobProcessIds', 'terminateJob', 'assignCurrentProcessToJob']

function assertNodePtyJobOwnership({ nativeName, native, platform = process.platform }) {
  if (platform !== 'win32' || nativeName !== 'conpty') {
    return
  }
  const exported = native?.module ?? native
  const missing = NODE_PTY_JOB_EXPORTS.filter((name) => typeof exported?.[name] !== 'function')
  if (missing.length === 0) {
    return
  }
  throw new Error(
    [
      `node-pty's conpty native is missing ${missing.join(', ')}.`,
      `Resolved from: ${native?.dir ?? 'unknown'}`,
      'That build cannot own a PTY tree, so terminatePtyJob degrades to "unavailable"',
      'and pane teardown falls back to guessing by PID ancestry.',
      'Rebuild node-pty from source so config/patches/node-pty@1.1.0.patch applies.'
    ].join(' ')
  )
}

module.exports = { assertNodePtyJobOwnership }
