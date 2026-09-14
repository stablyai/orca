import { describe, expect, it } from 'vitest'
import { describeError, isNotADirectory, isProvenAbsent } from './proven-absence'

describe('proven-absence', () => {
  it('trusts a string errno over the message', () => {
    expect(isProvenAbsent(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(true)
    // The message names ENOENT only inside a path; a definite EACCES must win.
    expect(
      isProvenAbsent(
        Object.assign(
          new Error("EACCES: denied, access '/a/ENOENT: no such file or directory/.git'"),
          {
            code: 'EACCES'
          }
        )
      )
    ).toBe(false)
  })

  it('falls back to the message when no string code survived the relay', () => {
    // The SSH relay replaces string errnos with -32000, so this is the remote shape.
    expect(
      isProvenAbsent(
        Object.assign(new Error('ENOENT: no such file or directory, stat ...'), { code: -32000 })
      )
    ).toBe(true)
  })

  it('fails closed instead of throwing on a hostile or absent error shape', () => {
    const hostile = {
      get code(): string {
        throw new Error('boom')
      }
    }
    expect(() => isProvenAbsent(hostile)).not.toThrow()
    expect(isProvenAbsent(hostile)).toBe(false)
    expect(isProvenAbsent(null)).toBe(false)
    expect(isProvenAbsent(undefined)).toBe(false)
    expect(() => isNotADirectory(null)).not.toThrow()
  })

  it('recognises ENOTDIR as a definite answer', () => {
    expect(isNotADirectory(Object.assign(new Error('x'), { code: 'ENOTDIR' }))).toBe(true)
    expect(isNotADirectory(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false)
  })

  it('does not throw when an Error instance has a throwing code getter', () => {
    // R5: the old version delegated to isENOENT, which read `.code` a SECOND time unguarded.
    const e = new Error('probe')
    Object.defineProperty(e, 'code', {
      get() {
        throw new Error('boom')
      }
    })
    expect(() => isProvenAbsent(e)).not.toThrow()
    expect(isProvenAbsent(e)).toBe(false)
    expect(() => isNotADirectory(e)).not.toThrow()
  })

  it('fails closed when a throwing code getter masks a canonical absence message', () => {
    const e = new Error('ENOENT: no such file or directory, stat /missing')
    Object.defineProperty(e, 'code', {
      get() {
        throw new Error('boom')
      }
    })
    expect(isProvenAbsent(e)).toBe(false)
    expect(isNotADirectory(e)).toBe(false)
  })

  it('recognises the relay ENOTDIR shape, where the string errno did not survive', () => {
    expect(
      isNotADirectory(
        Object.assign(new Error("ENOTDIR: not a directory, stat '/x/.git'"), { code: -32000 })
      )
    ).toBe(true)
  })

  it('still consults the message when a wrapper attached a non-errno string code', () => {
    expect(
      isProvenAbsent(
        Object.assign(new Error("ENOENT: no such file or directory, stat '/x'"), {
          code: 'REMOTE_FS_ERROR'
        })
      )
    ).toBe(true)
  })

  it('does not match an errno quoted later in the message', () => {
    expect(
      isProvenAbsent(
        new Error("EACCES: denied, access '/a/ENOENT: no such file or directory/.git'")
      )
    ).toBe(false)
  })

  it('treats every real errno as authoritative, not just the two we branch on', () => {
    // A permission failure whose message quotes ENOENT is still a permission failure.
    for (const code of ['EACCES', 'ELOOP', 'ENAMETOOLONG', 'EPERM']) {
      expect(
        isProvenAbsent(
          Object.assign(new Error("ENOENT: no such file or directory, stat '/x'"), { code })
        )
      ).toBe(false)
    }
    // A non-errno domain code still falls through to the message, which is the SSH relay path.
    expect(
      isProvenAbsent(
        Object.assign(new Error("ENOENT: no such file or directory, stat '/x'"), {
          code: 'REMOTE_FS_ERROR'
        })
      )
    ).toBe(true)
  })

  it('describeError survives a throwing message getter', () => {
    const e = new Error('x')
    Object.defineProperty(e, 'message', {
      get() {
        throw new Error('boom')
      }
    })
    expect(() => describeError(e)).not.toThrow()
  })

  it('treats underscore errno families like EAI_* as authoritative', () => {
    // EAI_AGAIN is a real libuv code; missing it let a transient DNS failure whose message
    // quotes ENOENT read as proven absence.
    for (const code of ['EAI_AGAIN', 'EAI_NONAME']) {
      expect(
        isProvenAbsent(
          Object.assign(new Error("ENOENT: no such file or directory, stat '/x'"), { code })
        )
      ).toBe(false)
    }
  })
})
