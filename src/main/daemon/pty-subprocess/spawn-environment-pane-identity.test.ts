import { describe, expect, it } from 'vitest'
import { createDaemonPtyEnvironment } from './spawn-environment'
import { PANE_IDENTITY_ENV_KEYS } from '../../../shared/pane-identity-env'
import type { PtySubprocessOptions } from '../pty-subprocess'

// Why: the daemon outlives Electron and inherits its own process.env, which names whichever pane
// the daemon was started from. Pane identity that arrives by inheritance is always the wrong
// pane's, and ORCA_AGENT_LAUNCH_TOKEN is Orca's proof of authorship — an inherited one lets a pane
// satisfy a status fence a different pane set. Shared with the relay via PANE_IDENTITY_ENV_KEYS.
function daemonOpts(env: Record<string, string> | undefined): PtySubprocessOptions {
  return {
    shell: '/bin/sh',
    cwd: '/tmp',
    cols: 80,
    rows: 24,
    ...(env ? { env } : {})
  } as unknown as PtySubprocessOptions
}

describe('daemon pane identity env', () => {
  const leaked = {
    ORCA_PANE_KEY: 'daemon-own-tab:daemon-own-leaf',
    ORCA_TAB_ID: 'daemon-own-tab',
    ORCA_WORKTREE_ID: 'daemon-own-wt',
    ORCA_AGENT_LAUNCH_TOKEN: 'daemon-own-launch-token'
  }

  function withInheritedPaneIdentity<T>(run: () => T): T {
    const saved = new Map(Object.keys(leaked).map((key) => [key, process.env[key]]))
    Object.assign(process.env, leaked)
    try {
      return run()
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  }

  it('drops every inherited pane identity key the spawn did not ask for', () => {
    const env = withInheritedPaneIdentity(() => createDaemonPtyEnvironment(daemonOpts(undefined)))
    for (const key of PANE_IDENTITY_ENV_KEYS) {
      expect(`${key}=${env[key]}`).toBe(`${key}=undefined`)
    }
  })

  it('keeps only the pane identity this spawn explicitly named', () => {
    // Why a partial env: the spawn names the pane but not the token, which is exactly a
    // non-agent pane. The named key must survive and the unnamed one must not be inherited.
    const env = withInheritedPaneIdentity(() =>
      createDaemonPtyEnvironment(daemonOpts({ ORCA_PANE_KEY: 'tab-1:leaf-1' }))
    )
    expect(env.ORCA_PANE_KEY).toBe('tab-1:leaf-1')
    expect(`token=${env.ORCA_AGENT_LAUNCH_TOKEN}`).toBe('token=undefined')
    expect(`tab=${env.ORCA_TAB_ID}`).toBe('tab=undefined')
    expect(`wt=${env.ORCA_WORKTREE_ID}`).toBe('wt=undefined')
  })
})
