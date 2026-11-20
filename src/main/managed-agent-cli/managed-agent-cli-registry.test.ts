import { afterEach, expect, it } from 'vitest'
import { _setGuestWindowsDriveMountsForTests } from '../wsl/filesystem/wsl-guest-windows-drive-path'
import {
  appendManagedAgentDirsToChildPath,
  rememberManagedAgentRelease
} from './managed-agent-cli-registry'

afterEach(() => {
  rememberManagedAgentRelease('claude', null)
  _setGuestWindowsDriveMountsForTests(null)
})

it.skipIf(process.platform === 'win32').each([
  { mounts: [], path: '/usr/bin', expected: '/usr/bin:/data/agent-runtimes/claude/.current' },
  {
    mounts: ['/mnt/c'],
    path: '/usr/bin:/mnt/c/Users/me/AppData/Roaming/npm',
    expected: '/usr/bin:/data/agent-runtimes/claude/.current:/mnt/c/Users/me/AppData/Roaming/npm'
  }
])(
  'puts the release link on a terminal PATH, ahead of Windows-drive shims a WSL host cannot run: $mounts',
  ({ mounts, path, expected }) => {
    _setGuestWindowsDriveMountsForTests(mounts)
    rememberManagedAgentRelease('claude', {
      folder: '/data/agent-runtimes/claude/2.0',
      link: '/data/agent-runtimes/claude/.current'
    })
    const env: Record<string, string> = { PATH: path }
    appendManagedAgentDirsToChildPath(env, 'linux')
    expect(env.PATH).toBe(expected)
  }
)
