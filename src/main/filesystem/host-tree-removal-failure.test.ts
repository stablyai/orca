import { afterEach, describe, expect, it } from 'vitest'
import { describeRemovalFailure } from './host-tree-removal-failure'

const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const onPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value })

function messageFor(code: string, syscall: string, path: string): string {
  const failure = describeRemovalFailure(
    Object.assign(new Error(`${code}: ${syscall}`), { code, syscall, path })
  )
  return failure instanceof Error ? failure.message : ''
}

describe('describeRemovalFailure', () => {
  afterEach(() => hostPlatform && Object.defineProperty(process, 'platform', hostPlatform))

  it('names the folder a POSIX user cannot change instead of blaming another program', () => {
    onPlatform('linux')
    expect(messageFor('EACCES', 'unlink', '/w/sub/__pycache__/x.pyc')).toBe(
      '/w/sub/__pycache__/x.pyc could not be deleted: you do not have permission to change /w/sub/__pycache__ (it may be owned by another user). Change its owner or permissions, then delete again.'
    )
    expect(messageFor('EACCES', 'scandir', '/w/sub/private')).toContain(
      'you do not have permission to change /w/sub/private ('
    )
    expect(messageFor('EACCES', 'open', '/w/.git')).toBe(
      '/w/.git could not be deleted: permission denied. Check the owner and permissions of it and its folders, then delete again.'
    )
    expect(messageFor('EPERM', 'unlink', '/w/locked.txt')).toBe(
      '/w/locked.txt could not be deleted; it may be locked or owned by another user. Unlock it or change its owner, then delete again.'
    )
  })

  it('keeps the read-only or open-file advice on Windows', () => {
    onPlatform('win32')
    expect(messageFor('EACCES', 'unlink', 'C:\\w\\sub\\x.pyc')).toBe(
      'C:\\w\\sub\\x.pyc could not be deleted; it may be read-only or open in another program. Close any program using it and delete again.'
    )
  })
})
