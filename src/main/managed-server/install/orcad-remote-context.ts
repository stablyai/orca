import type { NodeRuntimeTarget } from '../../../shared/node-runtime-pin'
import type { SshTarget } from '../../../shared/ssh-types'
import type { OrcadActivationRecord } from '../activation/orcad-activation-record'
import { readOrcadActivationRecord } from '../activation/orcad-activation-record-store'
import { resolveOrcadRuntimeTarget } from '../lifecycle/orcad-runtime-target'
import { prepareWindowsOrcadHost } from '../host-state/orcad-windows-host-preparation'
import {
  isWslOrcadHostTarget,
  type OrcadHostTarget,
  type OrcadHostTransport
} from '../../ssh/orcad-host-transport'
import {
  decideOrcadMachineHome,
  orcadMachineDataRoot,
  orcadMachineHomeDir,
  orcadMachineHomeProbeCommand,
  orcadMachineOwnershipUnresolvedMessage,
  parseOrcadMachineHomeProbe
} from '../host-state/orcad-machine-home'
import {
  orcadMachineClaimCommand,
  readOrcadMachineClaimAnswer
} from '../host-state/orcad-machine-claim-command'
import { execOrcadRemote, type OrcadRemoteExecTarget } from './orcad-remote-runtime-control'
import { readRemoteHomeCommand } from '../../ssh/ssh-remote-commands'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  normalizeRemoteHome,
  validateRemoteHome,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import { detectRemoteHostPlatform } from '../../ssh/ssh-remote-platform-detection'
import { OrcadHostUnsupportedError } from '../../orcad/orcad-host-unavailable'
import { rememberSshHostPlatform } from '../../ssh/ssh-host-platform-memo'

/** Default SSH generic retains compatibility with lifecycle consumers requiring SSH-only fields. */
export type OrcadRemoteContext<Target extends OrcadHostTarget = SshTarget> = {
  activationRecord: OrcadActivationRecord
  /** Select a compatible runtime when host glibc is below the default pin's floor. */
  serverTarget: NodeRuntimeTarget
  connection: OrcadHostTransport
  host: RemoteHostPlatform
  /** Login or machine-specific home for shared-home isolation; userDataDir must follow the same owner. */
  remoteHome: string
  target: Target
  userDataDir: string
}

export async function resolveOrcadRemoteContext<Target extends OrcadHostTarget = SshTarget>(
  target: Target,
  connection: OrcadHostTransport,
  signal?: AbortSignal,
  detectedHost?: RemoteHostPlatform
): Promise<OrcadRemoteContext<Target>> {
  const host = detectedHost ?? (await detectRemoteHostPlatform(connection, { signal }))
  if (!host) {
    throw new OrcadHostUnsupportedError(
      isWslOrcadHostTarget(target)
        ? 'Orca’s server doesn’t support this WSL distro’s platform. Use an x64 or arm64 Linux distro.'
        : 'Orca’s server doesn’t support this SSH host’s platform.'
    )
  }
  const remote = { conn: connection, host, signal }
  const { orcadHome: remoteHome, userDataDir } = await resolveOrcadMachineHome(
    remote,
    !isWslOrcadHostTarget(target)
  )
  const serverTarget = await resolveOrcadRuntimeTarget({
    conn: connection,
    host,
    signal
  })
  if (!isWslOrcadHostTarget(target)) {
    rememberSshHostPlatform(target.id, host, serverTarget)
  }
  if (isWindowsRemoteHost(host)) {
    // Prepare pinned Node before even reading activation state on Windows.
    await prepareWindowsOrcadHost({
      conn: connection,
      host,
      remoteHome,
      serverTarget,
      signal
    })
  }
  const activationRecord = await readOrcadActivationRecord({
    ...remote,
    remoteHome
  })
  return {
    activationRecord,
    serverTarget,
    connection,
    host,
    remoteHome,
    target,
    userDataDir
  }
}

/** Resolve per-machine state for shared POSIX homes; Windows and WSL retain login-home placement. */
export async function resolveOrcadMachineHome(
  remote: OrcadRemoteExecTarget,
  keyByMachine: boolean
): Promise<{ loginHome: string; orcadHome: string; userDataDir: string }> {
  const { host } = remote
  if (!keyByMachine || isWindowsRemoteHost(host)) {
    const loginHome = normalizeRemoteHome(
      await execOrcadRemote(remote, readRemoteHomeCommand(host)),
      host
    )
    if (!validateRemoteHome(loginHome, host)) {
      throw new Error(`Remote home is not a valid path: ${loginHome.slice(0, 100)}`)
    }
    return {
      loginHome,
      orcadHome: loginHome,
      userDataDir: joinRemotePath(host, loginHome, '.orca')
    }
  }
  const probe = parseOrcadMachineHomeProbe(
    await execOrcadRemote(remote, orcadMachineHomeProbeCommand(host)),
    host
  )
  const { loginHome } = probe
  let decision = decideOrcadMachineHome(probe, host)
  if (decision.kind === 'unresolved') {
    throw new Error(
      orcadMachineOwnershipUnresolvedMessage(
        decision.machineKey,
        probe.identity?.hostname ?? null,
        decision.cause
      )
    )
  }
  if (decision.kind === 'claim') {
    const won = readOrcadMachineClaimAnswer(
      await execOrcadRemote(remote, orcadMachineClaimCommand(host, loginHome, decision.machineKey))
    )
    if (won.state !== 'present') {
      throw new Error(won.message)
    }
    decision =
      won.machineKey === decision.machineKey
        ? { kind: 'login-home' }
        : { kind: 'machine-home', machineKey: decision.machineKey }
  }
  if (decision.kind === 'login-home') {
    return {
      loginHome,
      orcadHome: loginHome,
      userDataDir: joinRemotePath(host, loginHome, '.orca')
    }
  }
  const orcadHome = orcadMachineHomeDir(host, loginHome, decision.machineKey)
  await execOrcadRemote(remote, `umask 077; mkdir -p ${quotePosixShell(orcadHome)}`)
  return {
    loginHome,
    orcadHome,
    userDataDir: orcadMachineDataRoot(host, loginHome, decision.machineKey)
  }
}
