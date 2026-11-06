import { describe, expect, it, vi } from 'vitest'
import type { IPtyProvider } from '../../providers/pty-provider-contract'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../../shared/setup-agent-sequencing'
import { resolvePtySpawnHostEnv } from './spawn-host-env'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/orca-provider-test', isReady: () => true }
}))
vi.mock('../../codex/history/index/codex-state-db-backfill-recovery', () => ({
  ensureCodexStateDbBackfillRecoveryStarted: async () => {}
}))
vi.mock('../../pty/shell-startup/codex-resume-provider-launch', () => ({
  pinCodexResumeProviderLaunch: async (args: { command: string }) => {
    if (args.command !== 'codex resume saved-session') {
      throw new Error('Not a direct Codex launch')
    }
    return 'codex -c model_provider=openai resume saved-session'
  }
}))

function spawn(command: string, env?: Record<string, string>) {
  const providerSession = { key: 'session_id' as const, id: 'saved-session' }
  const resume = {
    codexResumeHome: {
      outcome: 'resume' as const,
      codexHomePath: '/saved/account',
      modelProvider: 'openai'
    },
    command,
    notifyResumeUnavailable: false,
    droppedResumeArgv: false,
    providerSession
  }
  return resolvePtySpawnHostEnv({
    launchAgent: 'codex',
    command,
    resumeProviderSession: providerSession,
    env,
    cwd: '/project',
    shellOverride: 'powershell.exe',
    expectedWslDistro: null,
    codexSelectionTarget: { runtime: 'host' },
    preAdopted: false,
    isDaemonHostSpawn: false,
    sessionId: undefined,
    callerNamedSession: true,
    mintedSessionId: false,
    resumeOnSelectedAccount: false,
    emptySessionIdSkipsHostEnv: false,
    requestedAgentTeamsPath: undefined,
    // This window-only env preparation returns before accessing provider operations.
    provider: {} as IPtyProvider,
    deps: {
      prepareCodexResumeHome: () => ({
        providerSession,
        preparation: Promise.resolve(resume.codexResumeHome)
      }),
      resolveCodexResumeLaunch: async () => resume,
      noCodexResumeLaunch: () => resume,
      reconcileSharedRuntimeResumeHome: async () => '/saved/account',
      stripSequencedStartupResumeArgv: (value) => value,
      getSelectedCodexHomePath: () => '/saved/account'
    }
  })
}

describe('native Codex provider pin at the common spawn boundary', () => {
  it('pins a direct window launch', async () => {
    const result = await spawn('codex resume saved-session')
    expect(result.launchCommand).toBe('codex -c model_provider=openai resume saved-session')
  })

  it.each(['powershell setup-wrapper.ps1', 'bash -lc setup-wrapper'])(
    'pins the inner launch of %s',
    async (wrapper) => {
      const result = await spawn(wrapper, {
        [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: 'codex resume saved-session'
      })
      expect(result.launchCommand).toBe(wrapper)
      expect(result.baseEnv?.[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]).toBe(
        'codex -c model_provider=openai resume saved-session'
      )
    }
  )
})
