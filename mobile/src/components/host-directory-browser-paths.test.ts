import { describe, expect, it } from 'vitest'
import {
  driveRootOf,
  isAtHostBrowseRoot,
  isDrivePath,
  isDriveRoot,
  joinHostBrowsePath,
  parentHostBrowsePath
} from './host-directory-browser-paths'

describe('host directory browser paths', () => {
  describe('isDrivePath', () => {
    it('recognizes drive letters with backslashes, slashes, or bare drive colons', () => {
      expect(isDrivePath('C:\\')).toBe(true)
      expect(isDrivePath('D:/')).toBe(true)
      expect(isDrivePath('e:')).toBe(true)
      expect(isDrivePath('C:\\Users\\alice')).toBe(true)
      expect(isDrivePath('d:/code/orca')).toBe(true)
    })

    it('rejects POSIX paths, relative paths, and empty strings', () => {
      expect(isDrivePath('/Users')).toBe(false)
      expect(isDrivePath('/home/me')).toBe(false)
      expect(isDrivePath('relative/path')).toBe(false)
      expect(isDrivePath('')).toBe(false)
    })
  })

  describe('isDriveRoot', () => {
    it('returns true for drive root specifiers', () => {
      expect(isDriveRoot('C:\\')).toBe(true)
      expect(isDriveRoot('C:/')).toBe(true)
      expect(isDriveRoot('C:')).toBe(true)
      expect(isDriveRoot('d:\\')).toBe(true)
    })

    it('returns false for paths containing subdirectories or POSIX paths', () => {
      expect(isDriveRoot('C:\\code')).toBe(false)
      expect(isDriveRoot('d:/sub')).toBe(false)
      expect(isDriveRoot('/')).toBe(false)
      expect(isDriveRoot('')).toBe(false)
    })
  })

  describe('driveRootOf', () => {
    it('extracts uppercase drive root with trailing backslash', () => {
      expect(driveRootOf('D:\\code\\orca')).toBe('D:\\')
      expect(driveRootOf('c:/Users')).toBe('C:\\')
      expect(driveRootOf('e:')).toBe('E:\\')
    })

    it('returns null for non-drive paths', () => {
      expect(driveRootOf('/Users/alice')).toBe(null)
      expect(driveRootOf('something')).toBe(null)
      expect(driveRootOf('')).toBe(null)
    })
  })

  describe('isAtHostBrowseRoot', () => {
    it('returns true for / and empty string', () => {
      expect(isAtHostBrowseRoot('/')).toBe(true)
      expect(isAtHostBrowseRoot('')).toBe(true)
    })

    it('returns false for directories and drive roots', () => {
      expect(isAtHostBrowseRoot('/home')).toBe(false)
      expect(isAtHostBrowseRoot('C:\\')).toBe(false)
    })
  })

  describe('joinHostBrowsePath', () => {
    it('handles Windows drive list root / + D:\\ -> D:\\', () => {
      expect(joinHostBrowsePath('/', 'D:\\', 'win32')).toBe('D:\\')
      expect(joinHostBrowsePath('', 'D:\\', 'win32')).toBe('D:\\')
    })

    it('handles Windows drive path D:\\code + orca -> D:\\code\\orca', () => {
      expect(joinHostBrowsePath('D:\\code', 'orca', 'win32')).toBe('D:\\code\\orca')
    })

    it('handles Windows drive root D:\\ + orca -> D:\\orca', () => {
      expect(joinHostBrowsePath('D:\\', 'orca', 'win32')).toBe('D:\\orca')
    })

    it('handles POSIX / + Users -> /Users', () => {
      expect(joinHostBrowsePath('/', 'Users', 'posix')).toBe('/Users')
      expect(joinHostBrowsePath('', 'Users', 'posix')).toBe('/Users')
    })

    it('handles POSIX /Users + alice -> /Users/alice', () => {
      expect(joinHostBrowsePath('/Users', 'alice', 'posix')).toBe('/Users/alice')
    })
  })

  describe('parentHostBrowsePath', () => {
    it('handles Windows drive root C:\\ -> / to trigger host listWindowsDrives()', () => {
      expect(parentHostBrowsePath('C:\\', 'win32')).toBe('/')
      expect(parentHostBrowsePath('C:/', 'win32')).toBe('/')
      expect(parentHostBrowsePath('C:', 'win32')).toBe('/')
    })

    it('handles Windows subpaths', () => {
      expect(parentHostBrowsePath('D:\\code\\orca', 'win32')).toBe('D:\\code')
      expect(parentHostBrowsePath('D:\\code', 'win32')).toBe('D:\\')
    })

    it('handles POSIX paths', () => {
      expect(parentHostBrowsePath('/Users/alice', 'posix')).toBe('/Users')
      expect(parentHostBrowsePath('/Users', 'posix')).toBe('/')
      expect(parentHostBrowsePath('/', 'posix')).toBe('/')
      expect(parentHostBrowsePath('', 'posix')).toBe('/')
    })
  })
})
