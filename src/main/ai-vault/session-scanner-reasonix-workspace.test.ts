import { expect, it } from 'vitest'
import { reasonixSessionLayout } from '../../shared/reasonix-session-paths'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import {
  reasonixCollisionProjectName,
  reasonixWorkspaceSlug,
  resolveReasonixWorkspace
} from './session-scanner-reasonix-workspace'

const host = getRemoteHostPlatform('linux-x64')
function layout(project: string) {
  const value = reasonixSessionLayout(`/host/projects/${project}/sessions-v4/id/events.frames`)
  if (!value) {
    throw new Error('Invalid fixture layout')
  }
  return value
}

it('matches a supplied host root without reversing ambiguous native slugs', () => {
  expect(resolveReasonixWorkspace(layout('-work-tree'), host, ['/work/tree'], null)).toBe(
    '/work/tree'
  )
  expect(
    resolveReasonixWorkspace(layout('-work-tree'), host, ['/work/tree', '/work-tree'], null)
  ).toBeNull()
  expect(resolveReasonixWorkspace(layout('-work-tree'), host, [], null)).toBeNull()
})

it('requires an exact native collision marker and hash', () => {
  const root = '/work/tree'
  const project = reasonixCollisionProjectName(root)
  expect(resolveReasonixWorkspace(layout(project), host, [], Buffer.from(`${root}\n`))).toBe(root)
  for (const marker of [root, `${root}\r\n`, '/different\n', '/work/../tree\n']) {
    expect(() => resolveReasonixWorkspace(layout(project), host, [], Buffer.from(marker))).toThrow(
      'ownership'
    )
  }
})

it('preserves native Windows case folding and Linux roots carried over WSL paths', () => {
  const windows = getRemoteHostPlatform('win32-x64')
  const winLayout = reasonixSessionLayout(
    'C:\\rx\\projects\\c--work-tree\\sessions-v4\\id\\events.frames'
  )
  if (!winLayout) {
    throw new Error('Invalid Windows fixture layout')
  }
  expect(resolveReasonixWorkspace(winLayout, windows, ['C:\\Work\\Tree'], null)).toBe(
    'c:\\work\\tree'
  )
  expect(resolveReasonixWorkspace(layout('-work-Tree'), windows, ['/work/Tree'], null)).toBe(
    '/work/Tree'
  )
})

it('bounds native UTF-8 slugs at 255 bytes and retains an FNV-1a suffix', () => {
  const short = `/${'a'.repeat(254)}`
  expect(reasonixWorkspaceSlug(short)).toBe(`-${'a'.repeat(254)}`)
  const long = `/${'界'.repeat(90)}`
  expect(Buffer.byteLength(reasonixWorkspaceSlug(long))).toBeLessThanOrEqual(255)
  expect(reasonixWorkspaceSlug(long)).toMatch(/-[a-f0-9]{16}$/)
  expect(reasonixWorkspaceSlug(long)).not.toContain('\uFFFD')
  expect(reasonixWorkspaceSlug(`${long}x`)).not.toBe(reasonixWorkspaceSlug(long))
})
