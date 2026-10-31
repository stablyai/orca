import { describe, expect, it } from 'vitest'
import { enrichPort, normalizeWorkspacePortProbes } from './local-workspace-port-attribution'
import { AdvertisedUrlWatcher } from './advertised-url-watcher'

it('carries the banner terminal only while the listener PID still matches', () => {
  const watcher = new AdvertisedUrlWatcher()
  const worktrees = normalizeWorkspacePortProbes([
    { id: 'wt', repoId: 'repo', displayName: 'main', path: '/repo' }
  ])
  watcher.bindPty('pty-frontend', 'wt')
  watcher.ingest('pty-frontend', 'Ready http://localhost:4008\n')
  const listener = { host: '127.0.0.1', port: 4008, pid: 123, cwd: '/repo' }
  expect(enrichPort(listener, worktrees, watcher)).toMatchObject({ sourcePtyId: 'pty-frontend' })
  expect(enrichPort({ ...listener, pid: 124 }, worktrees, watcher)).not.toHaveProperty(
    'sourcePtyId'
  )
})

describe('unavailable log sources', () => {
  it('does not attach workspace terminal metadata to external listeners', () => {
    const watcher = new AdvertisedUrlWatcher()
    watcher.bindPty('pty', 'wt')
    watcher.ingest('pty', 'http://localhost:4008\n')
    expect(enrichPort({ host: '127.0.0.1', port: 4008 }, [], watcher)).not.toHaveProperty(
      'sourcePtyId'
    )
  })
})
