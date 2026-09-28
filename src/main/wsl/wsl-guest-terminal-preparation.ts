import {
  getInheritedAgentHookEnvKeysToDelete,
  mergePtyEnvDeletions
} from '../ipc/pty/host-env/pi-agent'
import {
  detectExplicitPiAgentKindFromCommand,
  isPiCompatibleAgentType
} from '../../shared/pi-agent-kind'
import { resolveSetupAgentSequenceLaunchCommand } from '../../shared/setup-agent-sequencing'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { posix } from 'node:path'
import { waitForPromiseWithSignal, throwIfSignalAborted } from '../../shared/abort-signal-reason'
import { toRelayWslPtyId, parseAppWslPtyId } from '../../shared/wsl-pty-id'
import { buildPtyHostEnv } from '../ipc/pty/host-env/assembly'
import type { BuildPtyHostEnvOptions } from '../ipc/pty/host-env/types'
import type { PtySpawnOptions } from '../providers/types'
import { wslHookRelayManager } from '../agent-hooks/wsl-hook-relay-manager'
import {
  prepareWslGuestSpawnOptions,
  capturedWslGuestSpawnOwner,
  type PreparedWslGuestSpawnOwner
} from './wsl-guest-spawn-options'

/** Account selection/auth are prepared by the existing spawn preflight before this boundary. */
export async function prepareWslGuestTerminalSpawn(
  captured: PreparedWslGuestSpawnOwner,
  options: PtySpawnOptions,
  policy: BuildPtyHostEnvOptions,
  signal?: AbortSignal,
  mode?: 'confirmed-exited'
): Promise<PtySpawnOptions> {
  const prepared = capturedWslGuestSpawnOwner(captured)
  throwIfSignalAborted(signal)
  if (
    mode === 'confirmed-exited' &&
    (!prepared.daemon || !options.sessionId || options.isNewSession)
  ) {
    throw new Error('Cold restore requires an existing guest daemon terminal identity')
  }
  if (options.sessionId && !options.isNewSession) {
    toRelayWslPtyId(prepared.owner, options.sessionId)
    if (mode !== 'confirmed-exited') {
      return prepareWslGuestSpawnOptions(prepared, options, signal)
    }
  }
  if (
    options.attachOnly ||
    (mode !== 'confirmed-exited' && options.sessionId && parseAppWslPtyId(options.sessionId))
  ) {
    throw new Error('Guest spawn preparation cannot replace an existing terminal owner')
  }
  const { userName: user, distro } = prepared.endpoint
  if (!user || distro !== prepared.owner.distro || !options.sessionId) {
    throw new Error('Guest spawn preparation requires an explicit owner and fresh desktop identity')
  }
  const selectedHome = policy.selectedCodexHomePath
  const uncHome = selectedHome ? parseWslUncPath(selectedHome) : null
  if (
    selectedHome &&
    (uncHome
      ? uncHome.distro.toLowerCase() !== distro.toLowerCase()
      : !selectedHome.startsWith('/'))
  ) {
    throw new Error('Selected account home does not belong to the guest owner')
  }
  const ownedPolicy = {
    ...policy,
    selectedCodexHomePath: uncHome?.linuxPath ?? selectedHome,
    isWsl: true,
    wslDistro: distro,
    wslUser: user
  }
  if (policy.agentStatusHooksEnabled) {
    const kind = isPiCompatibleAgentType(policy.launchAgent)
      ? policy.launchAgent
      : policy.launchAgent === undefined
        ? detectExplicitPiAgentKindFromCommand(
            resolveSetupAgentSequenceLaunchCommand(options.env ?? {}, policy.launchCommand)
          )
        : null
    let ready = true
    try {
      await waitForPromiseWithSignal(
        wslHookRelayManager.ensureForDistro(
          distro,
          ownedPolicy.selectedCodexHomePath,
          kind === 'pi' || kind === 'omp' ? kind : undefined,
          user
        ),
        signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000)
      )
    } catch (error) {
      throwIfSignalAborted(signal)
      ready = false
      console.warn('[wsl] Terminal hooks unavailable; continuing without hooks', error)
    }
    const endpoint = ready ? wslHookRelayManager.getGuestEndpointFilePath(distro, user) : null
    const root = posix.join(prepared.home, '.orca-wsl', 'agent-hooks')
    if (endpoint && (!endpoint.startsWith(`${root}/`) || posix.normalize(endpoint) !== endpoint)) {
      throw new Error('Guest hook endpoint is unavailable for the terminal owner')
    }
    ownedPolicy.agentStatusHooksEnabled = Boolean(endpoint)
    if (!endpoint) {
      ownedPolicy.codexStatusHooksEnabled = false
    }
  }
  throwIfSignalAborted(signal)
  const env = buildPtyHostEnv(
    mode === 'confirmed-exited'
      ? toRelayWslPtyId(prepared.owner, options.sessionId)
      : options.sessionId,
    { ...options.env },
    ownedPolicy
  )
  return prepareWslGuestSpawnOptions(
    prepared,
    {
      ...options,
      env,
      envToDelete: mergePtyEnvDeletions(
        options.envToDelete,
        getInheritedAgentHookEnvKeysToDelete(env)
      )
    },
    signal,
    mode
  )
}
