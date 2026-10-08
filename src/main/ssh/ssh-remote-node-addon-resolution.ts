/**
 * Rung C's host Node lookup (design D6): the same candidates as the npm path, but the
 * check asks only for Node >= 18 and the addons' N-API level, never npm.
 */
import type { SshConnection } from './ssh-connection'
import type { RemoteNodeResolutionOptions } from './ssh-remote-node-install-guidance'
import { execCommand } from './ssh-relay-deploy-helpers'
import {
  commandOptions,
  memoizeCandidateCheck,
  throwIfAborted,
  tryResolveViaKnownPaths,
  tryResolveViaLoginShell,
  type CandidateCheck,
  type ProbeOptions
} from './ssh-remote-node-resolution'
import {
  buildPosixNodeToolchainProbe,
  hostNodeMeetsAddonRequirements,
  parseHostNodeAddonFacts,
  type HostNodeAddonFacts
} from './ssh-remote-node-toolchain-probe'
import { isSshSessionLimitError } from './ssh-session-limit-error'

export type RemoteHostNodeForAddons = { nodePath: string; facts: HostNodeAddonFacts }

/**
 * Null means the probes answered and no Node qualified; a probe that never answered
 * throws instead, because null steps the runtime ladder down.
 */
export async function resolveRemoteHostNodeForAddons(
  conn: SshConnection,
  requiredNapi: number,
  options?: RemoteNodeResolutionOptions
): Promise<RemoteHostNodeForAddons | null> {
  const strict: ProbeOptions = { ...options, strict: true }
  const addonCheck: CandidateCheck<HostNodeAddonFacts> = memoizeCandidateCheck(
    async (candidate) => {
      const facts = await probeHostNodeAddonFacts(conn, candidate, strict)
      return hostNodeMeetsAddonRequirements(facts, requiredNapi) ? facts : null
    }
  )
  const found =
    (await tryResolveViaKnownPaths(conn, addonCheck, strict)) ??
    (await tryResolveViaLoginShell(conn, addonCheck, strict))
  return found ? { nodePath: found.nodePath, facts: found.result } : null
}

async function probeHostNodeAddonFacts(
  conn: SshConnection,
  nodePath: string,
  options: ProbeOptions
): Promise<HostNodeAddonFacts | null> {
  try {
    const output = await execCommand(
      conn,
      buildPosixNodeToolchainProbe(nodePath, 'addon-only'),
      commandOptions({ wrapCommand: true }, options)
    )
    return parseHostNodeAddonFacts(output)
  } catch (err) {
    if (options.rethrowSessionLimitErrors && isSshSessionLimitError(err)) {
      throw err
    }
    throwIfAborted(options)
    // Why: the probe ends in `|| true`, so a rejection means the host never answered.
    if (options.strict) {
      throw err
    }
    return null
  }
}
