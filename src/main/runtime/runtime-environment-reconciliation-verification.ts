import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { runtimeEnvironmentSshAccessBinding } from '../../shared/runtime-environment-ssh-access-store'
import { getPreferredPairingOffer } from '../../shared/runtime-environments'
import { verifyRuntimeEnvironmentIdentity } from './runtime-environment-identity-verification'
import { prepareRuntimeEnvironmentReconciliation } from '../../shared/runtime-environment-reconciliation-store'
import { runRuntimeEnvironmentReconciliationLifecycle } from './runtime-environment-reconciliation-lifecycle'

/** Proves both saved grants reach one host; this does not authorize deleting either registration. */
export async function verifyRuntimeEnvironmentReconciliation(
  userDataPath: string,
  args: { selectors: readonly [string, string]; signal?: AbortSignal }
) {
  args.signal?.throwIfAborted()
  const registrations = args.selectors.map((selector) => resolveEnvironment(userDataPath, selector))
  const [left, right] = registrations
  if (left.id === right.id) {
    throw new Error('Reconciliation requires two distinct runtime registrations.')
  }
  if (
    getPreferredPairingOffer(left).publicKeyB64 !== getPreferredPairingOffer(right).publicKeyB64 ||
    (left.runtimeId !== null && right.runtimeId !== null && left.runtimeId !== right.runtimeId)
  ) {
    throw new Error('Runtime registrations do not identify the same host.')
  }
  const verified = await Promise.all(
    registrations.map((environment) =>
      verifyRuntimeEnvironmentIdentity(environment, { signal: args.signal })
    )
  )
  args.signal?.throwIfAborted()
  if (verified[0].verifiedRuntimeId !== verified[1].verifiedRuntimeId) {
    throw new Error('Runtime registrations authenticated as different hosts.')
  }
  for (const expected of registrations) {
    const current = resolveEnvironment(userDataPath, expected.id)
    if (
      current.source !== expected.source ||
      JSON.stringify(runtimeEnvironmentSshAccessBinding(current)) !==
        JSON.stringify(runtimeEnvironmentSshAccessBinding(expected))
    ) {
      throw new Error('Runtime registration changed during reconciliation verification.')
    }
  }
  return { runtimeId: verified[0].verifiedRuntimeId, registrations }
}

export async function prepareVerifiedRuntimeEnvironmentReconciliation(
  userDataPath: string,
  args: {
    selectors: readonly [string, string]
    canonicalEnvironmentId: string
    requestId: string
    signal?: AbortSignal
  }
) {
  const registrations = args.selectors.map((selector) => resolveEnvironment(userDataPath, selector))
  return runRuntimeEnvironmentReconciliationLifecycle(userDataPath, registrations, async () => {
    const verified = await verifyRuntimeEnvironmentReconciliation(userDataPath, args)
    args.signal?.throwIfAborted()
    return prepareRuntimeEnvironmentReconciliation(userDataPath, {
      requestId: args.requestId,
      canonicalEnvironmentId: args.canonicalEnvironmentId,
      verifiedRuntimeId: verified.runtimeId,
      expectedRegistrations: verified.registrations
    })
  })
}
