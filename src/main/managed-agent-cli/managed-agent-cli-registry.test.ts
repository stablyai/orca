import { expect, it } from 'vitest'
import {
  appendManagedAgentDirsToChildPath,
  rememberManagedAgentRelease
} from './managed-agent-cli-registry'

it.skipIf(process.platform === 'win32')(
  'puts the release link on a terminal PATH, not the versioned folder updates reclaim',
  () => {
    rememberManagedAgentRelease('claude', {
      folder: '/data/agent-runtimes/claude/2.0',
      link: '/data/agent-runtimes/claude/.current'
    })
    const env: Record<string, string> = { PATH: '/usr/bin' }
    appendManagedAgentDirsToChildPath(env, 'linux')
    expect(env.PATH).toBe('/usr/bin:/data/agent-runtimes/claude/.current')
    rememberManagedAgentRelease('claude', null)
  }
)
