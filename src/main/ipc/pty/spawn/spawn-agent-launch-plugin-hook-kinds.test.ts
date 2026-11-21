import { afterEach, describe, expect, it } from 'vitest'
import type { ValidDiscoveredPlugin } from '../../../plugins/discovery/plugin-discovery'
import { setPluginHookRunner } from '../../../plugins/hooks/plugin-hook-dispatch'
import { createPluginHookRunner } from '../../../plugins/hooks/plugin-hook-participants'
import type { PluginWorkerHandle } from '../../../plugins/workers/parent-process/plugin-host-process-types'
import type { PluginHookContribution } from '../../../../shared/plugins/contributions/plugin-hook-contribution'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import { localProvider, setLocalPtyProvider } from '../provider/registry'
import { applyAgentLaunchPluginHook } from './spawn-agent-launch-plugin-hook'

type Seen = { pluginKey: string; launchKind: unknown }

const logged: string[] = []

/** Two installed plugins hook `agent.launch.before`; each sets an env key and tries to change the command. */
function installPlugins(hooks: Record<string, PluginHookContribution>): Seen[] {
  const seen: Seen[] = []
  const plugins = Object.entries(hooks).map(
    ([pluginKey, hook]) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook runner reads only these fields of a discovered plugin.
      ({
        pluginKey,
        isDev: false,
        rootDir: `/plugins/${pluginKey}`,
        consentFingerprint: pluginKey,
        manifest: { main: 'worker.js', contributes: { hooks: [hook] } }
      }) as never as ValidDiscoveredPlugin
  )
  setPluginHookRunner(
    createPluginHookRunner({
      plugins: () => plugins,
      isRuntimeApproved: () => true,
      isEnabled: () => true,
      logWarning: () => (line) => void logged.push(line),
      ensureWorker: async (plugin) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook runner calls only runHook on a worker.
        ({
          runHook: async (_event: string, payload: { command: string; launchKind: unknown }) => {
            seen.push({ pluginKey: plugin.pluginKey, launchKind: payload.launchKind })
            return {
              decision: 'continue',
              payload: {
                ...payload,
                command: `${payload.command} --changed`,
                env: { [`FROM_${plugin.pluginKey.toUpperCase()}`]: '1' }
              }
            }
          }
        }) as never as PluginWorkerHandle
    })
  )
  return seen
}

const launch = {
  launchAgent: 'claude' as const,
  command: 'claude --resume abc',
  env: { KEEP: '1' }
}

const realLocalProvider = localProvider

/** The local host answers whether `session` is still running (true), gone (false) or unknown (null). */
function hostAnswers(live: boolean | null): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch hook calls only probePtyLiveness on the host.
  setLocalPtyProvider({ probePtyLiveness: async () => live } as never as IPtyProvider)
}

afterEach(() => {
  setPluginHookRunner(null)
  setLocalPtyProvider(realLocalProvider)
  logged.length = 0
})

describe('agent.launch.before launch kinds', () => {
  it('a person resuming a session reaches resume plugins only; Orca keeps its command, logs the change and applies env', async () => {
    const seen = installPlugins({
      fresh: { event: 'agent.launch.before' },
      resumer: { event: 'agent.launch.before', launchKinds: ['new', 'resume'] },
      restorer: { event: 'agent.launch.before', launchKinds: ['restore'] }
    })

    // The Resume action's shape (resume-agent-session-in-workspace.ts).
    const resumed = await applyAgentLaunchPluginHook(
      {
        ...launch,
        spawnIntent: 'user-resume',
        resumeProviderSession: { key: 'session_id', id: 'abc' }
      },
      undefined
    )

    expect(seen).toEqual([{ pluginKey: 'resumer', launchKind: 'resume' }])
    expect(resumed.command).toBe('claude --resume abc')
    expect(resumed.env).toEqual({ KEEP: '1', FROM_RESUMER: '1' })
    expect(logged).toEqual(['hook agent.launch.before: command not changed: fixed for this event'])
  })

  it('Orca restoring a saved session reaches restore plugins, unless the session is still running', async () => {
    const seen = installPlugins({
      resumer: { event: 'agent.launch.before', launchKinds: ['resume'] },
      restorer: { event: 'agent.launch.before', launchKinds: ['restore'] }
    })
    const restore = { ...launch, spawnIntent: 'automatic-restore', sessionId: 'pane-session' }

    hostAnswers(true)
    expect(await applyAgentLaunchPluginHook(restore, undefined)).toEqual(restore)
    expect(seen).toEqual([])

    hostAnswers(false)
    const restarted = await applyAgentLaunchPluginHook(restore, undefined)
    expect(seen).toEqual([{ pluginKey: 'restorer', launchKind: 'restore' }])
    expect(restarted.env).toEqual({ KEEP: '1', FROM_RESTORER: '1' })

    // A pane visible when Orca restores it asks for user-resume admission; it is still a restore.
    seen.length = 0
    await applyAgentLaunchPluginHook(
      { ...launch, spawnIntent: 'user-resume', resumeOrigin: 'saved', sessionId: 'pane-session' },
      undefined
    )
    expect(seen).toEqual([{ pluginKey: 'restorer', launchKind: 'restore' }])
  })

  it('a new launch reaches the plugins that list new (the default), with launchKind "new"', async () => {
    const seen = installPlugins({
      fresh: { event: 'agent.launch.before' },
      resumer: { event: 'agent.launch.before', launchKinds: ['resume'] }
    })

    const started = await applyAgentLaunchPluginHook({ ...launch, command: 'claude' }, undefined)

    expect(seen).toEqual([{ pluginKey: 'fresh', launchKind: 'new' }])
    expect(started.command).toBe('claude --changed')
  })
})
