import { describe, expect, it } from 'vitest'

import { isENOENT, isPathAbsentError } from './filesystem-path-containment'

/** Relay JSON-RPC preserves Node ENOENT messages but replaces string codes; remote creation must still recognize expected absence. */
describe('isENOENT across the SSH relay boundary', () => {
  it('recognises a local Node error by its code', () => {
    const local = new Error(
      "ENOENT: no such file or directory, lstat '/tmp/nope'"
    ) as NodeJS.ErrnoException
    local.code = 'ENOENT'

    expect(isENOENT(local)).toBe(true)
  })

  it('recognises an error rebuilt from the relay with a numeric transport code', () => {
    // Relay response reconstruction preserves the message and replaces the code.
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

  it('does not treat a different errno as absent', () => {
    const denied = new Error("EACCES: permission denied, lstat '/root/x'") as NodeJS.ErrnoException
    denied.code = 'EACCES'

    expect(isENOENT(denied)).toBe(false)
  })

  it('does not match a message that merely mentions the word', () => {
    // Match the canonical phrase so unrelated ENOENT mentions cannot bypass collision checks.
    expect(isENOENT(new Error('fix: handle ENOENT better'))).toBe(false)
    expect(isENOENT(new Error('branch enoent-handling created'))).toBe(false)
  })

  it('ignores non-errors', () => {
    expect(isENOENT('ENOENT: no such file or directory')).toBe(false)
    expect(isENOENT(null)).toBe(false)
    expect(isENOENT(undefined)).toBe(false)
  })
})

describe('isPathAbsentError', () => {
  it('treats a path under a file as absent, but not a denied one', () => {
    // Terminal hard-wrap guesses may probe a child under a file (#32128).
    const underFile = Object.assign(new Error("ENOTDIR: not a directory, stat '/r/a.txt/b.txt'"), {
      code: 'ENOTDIR'
    })
    const denied = Object.assign(new Error("EACCES: permission denied, stat '/root/x'"), {
      code: 'EACCES'
    })

    expect(isPathAbsentError(underFile)).toBe(true)
    expect(isPathAbsentError(denied)).toBe(false)
  })
})
