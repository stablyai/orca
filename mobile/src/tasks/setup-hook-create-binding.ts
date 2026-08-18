import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import {
  normalizeSetupHookTrust,
  setupHookApprovalFromTrust,
  type SetupHookApproval,
  type SetupHookTrust
} from './setup-hook-trust'

export type MobileSetupDecision = 'inherit' | 'run' | 'skip'
type SetupRunPolicy = 'ask' | 'run-by-default' | 'skip-by-default'

export type RepoHooksResponse = {
  hooks: { scripts?: { setup?: string } } | null
  source: string | null
  setupRunPolicy?: SetupRunPolicy
  setupTrust?: SetupHookTrust
}

export type SetupHookCreateResolution =
  | { kind: 'decision'; decision: MobileSetupDecision; setupTrust?: SetupHookTrust }
  | { kind: 'prompt'; command: string; source: string | null; setupTrust?: SetupHookTrust }

export async function resolveSetupHookCreate(args: {
  client: RpcClient
  repoId: string
  override?: Exclude<MobileSetupDecision, 'inherit'>
}): Promise<SetupHookCreateResolution> {
  const response = await args.client.sendRequest('repo.hooks', { repo: `id:${args.repoId}` })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  const result = (response as RpcSuccess).result as RepoHooksResponse
  const setupTrust = normalizeSetupHookTrust(result.setupTrust) ?? undefined
  const setupCommand = setupTrust?.scriptContent ?? result.hooks?.scripts?.setup?.trim()
  if (!setupCommand) {
    return { kind: 'decision', decision: 'inherit' }
  }
  if (args.override) {
    return { kind: 'decision', decision: args.override, setupTrust }
  }
  const setupRunPolicy = result.setupRunPolicy ?? 'run-by-default'
  if (setupRunPolicy === 'ask') {
    return { kind: 'prompt', command: setupCommand, source: result.source, setupTrust }
  }
  return {
    kind: 'decision',
    decision: setupRunPolicy === 'run-by-default' ? 'run' : 'skip',
    setupTrust
  }
}

export type SetupHookCreateBinding = {
  decision: MobileSetupDecision
  approval?: SetupHookApproval
  /** Present when an intended run was downgraded, so the caller can say why. */
  suppressedWarning?: string
}

const HOST_UNSUPPORTED_WARNING =
  'Setup hook skipped: update the remote Orca server to run approved setup hooks.'
const UNVERIFIABLE_WARNING =
  'Setup hook skipped: this host did not issue an approval that could be verified.'

export function bindSetupHookCreate(args: {
  decision: MobileSetupDecision
  setupTrust?: SetupHookTrust | null
  approvalSupported: boolean
}): SetupHookCreateBinding {
  if (args.decision === 'skip') {
    return { decision: 'skip' }
  }
  if (!args.approvalSupported) {
    // Why: 'inherit' only reaches here when the repo has no setup content, so only an
    // explicit run is a suppression the user needs told about.
    return args.decision === 'run'
      ? { decision: 'skip', suppressedWarning: HOST_UNSUPPORTED_WARNING }
      : { decision: 'skip' }
  }
  if (args.decision !== 'run') {
    return { decision: args.decision }
  }
  const approval = setupHookApprovalFromTrust(args.setupTrust)
  return approval
    ? { decision: 'run', approval }
    : { decision: 'skip', suppressedWarning: UNVERIFIABLE_WARNING }
}
