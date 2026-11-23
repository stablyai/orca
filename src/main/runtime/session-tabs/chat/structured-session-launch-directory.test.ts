import { describe, expect, it } from 'vitest'
import { launchDirectoryInsideWorkspace } from './structured-session-launch-directory'

describe('launchDirectoryInsideWorkspace', () => {
  it('runs a chat in a folder inside the workspace and refuses one outside it', () => {
    const root = 'C:\\Users\\me\\UCSD-Courses'
    expect(launchDirectoryInsideWorkspace(root, 'C:/Users/me/UCSD-Courses/DSC102/PA4', false)).toBe(
      'C:/Users/me/UCSD-Courses/DSC102/PA4'
    )
    expect(
      launchDirectoryInsideWorkspace(root, 'c:\\users\\me\\ucsd-courses', false)
    ).toBeUndefined()
    expect(launchDirectoryInsideWorkspace(root, undefined, true)).toBe(root)
    expect(() => launchDirectoryInsideWorkspace(root, 'C:\\Users\\me\\Other', false)).toThrow()
    expect(() =>
      launchDirectoryInsideWorkspace('/home/me/repo', '/home/me/repo-sibling/x', false)
    ).toThrow()
  })
})
