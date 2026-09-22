import { describe, expect, it } from 'vitest'

import { isENOENT } from './filesystem-path-containment'

/**
 * Creating a worktree over SSH failed with a raw
 * `ENOENT: no such file or directory, lstat '/home/neil/projects/orca-test1234'`.
 *
 * The path was the one about to be created, so its absence was correct and expected — the caller
 * (`remotePathExists`) asks exactly that question and returns false on ENOENT. It could not: the
 * error was raised on the SSH host, crossed the relay as JSON-RPC, and
 * `ssh-channel-multiplexer.handleResponse` rebuilds it with the TRANSPORT's numeric code. Node's
 * 'ENOENT' string code is gone by construction, so the check never matched and the error was
 * rethrown at the user.
 *
 * The stack in the trace log is what settles it — the throw originates in `handleResponse`, not in
 * any local fs call, which is why hunting for a local `lstat` found nothing.
 */
describe('isENOENT across the SSH relay boundary', () => {
  it('recognises a local Node error by its code', () => {
    const local = new Error(
      "ENOENT: no such file or directory, lstat '/tmp/nope'"
    ) as NodeJS.ErrnoException
    local.code = 'ENOENT'

    expect(isENOENT(local)).toBe(true)
  })

  it('recognises an error rebuilt from the relay with a numeric transport code', () => {
    // Exactly what handleResponse produces: message preserved, code replaced by the JSON-RPC code.
    const fromRelay = new Error(
      "ENOENT: no such file or directory, lstat '/home/neil/projects/orca-test1234'"
    )
    Object.defineProperty(fromRelay, 'code', { value: -32000 })

    expect(isENOENT(fromRelay), 'a remote missing path must read as absent, not as a failure').toBe(
      true
    )
  })

  it('recognises it through the IPC wrapper the renderer sees', () => {
    const throughIpc = new Error(
      "Error invoking remote method 'worktrees:create': Error: ENOENT: no such file or directory, lstat '/home/neil/projects/orca-test1234-3'"
    )

    expect(isENOENT(throughIpc)).toBe(true)
  })

  it('recognises an error carrying no code at all', () => {
    expect(isENOENT(new Error("ENOENT: no such file or directory, stat '/x'"))).toBe(true)
  })

  it('does not treat a different errno as absent', () => {
    const denied = new Error("EACCES: permission denied, lstat '/root/x'") as NodeJS.ErrnoException
    denied.code = 'EACCES'

    expect(isENOENT(denied)).toBe(false)
  })

  it('does not match a message that merely mentions the word', () => {
    // The full canonical phrase is required, so a branch name, a log line, or a user's commit
    // message cannot make an existing path look missing — which would silently skip collision
    // checks rather than report them.
    expect(isENOENT(new Error('fix: handle ENOENT better'))).toBe(false)
    expect(isENOENT(new Error('branch enoent-handling created'))).toBe(false)
  })

  it('ignores non-errors', () => {
    expect(isENOENT('ENOENT: no such file or directory')).toBe(false)
    expect(isENOENT(null)).toBe(false)
    expect(isENOENT(undefined)).toBe(false)
  })
})
