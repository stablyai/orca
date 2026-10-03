import { homedir } from 'node:os'
import { posix } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-status-hooks-setting'
import { toWindowsWslUncPath } from '../../shared/wsl-paths'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { resolveClaudeCommand } from '../codex-cli/command'
import { probeClaudeCliVersionCached } from '../claude/claude-hook-event-versions'
import { describeClaudeProfile } from './claude-profile-paths'
import { ClaudeProfileSetupWorker } from './claude-profile-worker'
import { prepareClaudeWslGuest } from './claude-profile-wsl-transport'
import { runClaudeCommandProcess, type ClaudeCommandConfig } from './claude-command-process'
import type { ClaudeAccountSelectionTarget } from './runtime-selection'
import { recordClaudeProfileSetupReport } from './claude-profile-setup-issues'

/** The profile is final before Claude is started; only Claude writes the login. */
export async function prepareClaudeProfileLogin(
  accountId: string,
  target: ClaudeAccountSelectionTarget,
  settings: Pick<GlobalSettings, 'agentStatusHooksEnabled' | 'disabledTuiAgents'>
): Promise<{ config: ClaudeCommandConfig; provision: () => Promise<void> }> {
  const hooksEnabled = isAgentStatusHooksEnabledForAgent(settings, 'claude')
  if (target.runtime === 'wsl') {
    if (!target.wslDistro) {
      throw new Error('Choose a WSL distro before signing in.')
    }
    const distro = target.wslDistro
    const guest = await prepareClaudeWslGuest(distro, 'boot')
    const profile = describeClaudeProfile(posix.join(guest.home, '.local/share/orca'), accountId, {
      executionHostId: 'local',
      runtime: 'wsl',
      distro
    })
    const provision = async () => {
      const result = await guest.request(
        { action: 'create', distro, accountId, userHome: guest.home, hooksEnabled },
        'boot'
      )
      if (result.report) {
        recordClaudeProfileSetupReport(accountId, result.report)
      }
      if (result.report?.outcome !== 'prepared') {
        throw new Error('Claude profile could not be prepared.')
      }
    }
    await provision()
    return {
      config: {
        windowsPath: toWindowsWslUncPath(profile.home, distro),
        linuxPath: profile.home,
        wslDistro: distro
      },
      provision
    }
  }
  const dataRoot = getAppEnvironment().getPath('userData')
  const profile = describeClaudeProfile(dataRoot, accountId, {
    executionHostId: 'local',
    runtime: 'host'
  })
  const worker = new ClaudeProfileSetupWorker()
  const provision = async () => {
    const report = await worker.prepare({
      dataRoot,
      profile,
      userHome: homedir(),
      hooksEnabled,
      claudeVersion: (await probeClaudeCliVersionCached(resolveClaudeCommand())) ?? undefined
    })
    recordClaudeProfileSetupReport(accountId, report)
    if (report.outcome !== 'prepared') {
      throw new Error('Claude profile could not be prepared.')
    }
  }
  await provision()
  return { config: { windowsPath: profile.home, linuxPath: null, wslDistro: null }, provision }
}

/** Runs only Claude's login; finishing reads the identity, so a supersede cannot discard it. */
export async function loginToClaudeProfile(
  config: ClaudeCommandConfig,
  setCancel: (cancel: (() => boolean) | null) => void,
  run = runClaudeCommandProcess
): Promise<void> {
  const controller = new AbortController()
  setCancel(() => {
    if (controller.signal.aborted) {
      return false
    }
    controller.abort()
    return true
  })
  try {
    await run(['auth', 'login', '--claudeai'], config, 180_000, {
      signal: controller.signal,
      keepStdinOpen: true
    })
  } finally {
    setCancel(null)
  }
}
