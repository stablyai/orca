// The authoritative agent-launch resolver. Pure CPU: no fs, subprocess, network,
// or listeners (I15) — every host-produced input arrives in the request. Returns
// a fully resolved launch, a typed launch failure, or a request/control-plane
// error; never null, never a throw for expected lifecycle state.

import type { GlobalSettings } from '../../shared/types'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { resolveStartupShell, CMD_UNENCODABLE_CHAR_RE } from '../../shared/tui-agent-startup-shell'
import type { AgentStartupShell } from '../../shared/tui-agent-startup-shell'
import { getAgentResumeArgv, isResumableTuiAgent } from '../../shared/agent-session-resume'
import type { AgentCatalog } from '../../shared/agent-catalog-normalization'
import type {
  AgentLaunchResolution,
  AgentLaunchSnapshot,
  ResolveAgentLaunchRequest
} from '../../shared/agent-launch-host-contract'
import type { AgentLaunchNotice, AgentLaunchRequestError } from '../../shared/agent-launch-contract'
import { resolveSelection } from './resolve-agent-selection'
import { buildLaunchContext } from './resolve-agent-launch-context'
import { assembleCommand } from './resolve-agent-command'
import { interpolateVariables, prepareVariableValues } from './resolve-agent-variables'
import { clientOfIntent } from './resolve-agent-env-admission'
import { checkCommandTooLong, checkEnvPayloadTooLarge } from './agent-launch-payload-caps'
import { composeAgentLaunchEnv, inheritedEnvLayer } from './compose-agent-launch-env'
import { buildResolvedLaunch, type LaunchTarget } from './resolve-agent-launch-result'
import {
  resolveMobileRemoveOnlyReplayEnv,
  snapshotDefinitionChangedNotice
} from './resolve-agent-launch-snapshot-comparison'

export type ResolveAgentLaunchOutcome =
  | AgentLaunchResolution
  | { ok: false; requestError: AgentLaunchRequestError }

function hasUserPathOverride(env: Record<string, string>): boolean {
  return Object.keys(env).some((key) => key.toLowerCase() === 'path')
}

/** The env a native-Windows spawn actually ships. CreateProcess rejects the whole
 *  inherited+custom block over its ceiling, so measuring the custom layer alone
 *  admits a launch that then fails opaquely at spawn. Every other target measures
 *  argv+env bytes instead and composes nothing here. */
function spawnEnvForPayloadCap(
  env: Record<string, string>,
  target: LaunchTarget,
  inheritedEnv: NodeJS.ProcessEnv | undefined
): Record<string, string> {
  if (target.platform !== 'win32' || target.execution !== 'native' || target.isRemote) {
    return env
  }
  // Only the machine that will spawn owns the inherited layer; a win32 target
  // resolved from anywhere else has no local block to measure.
  const source = inheritedEnv ?? (process.platform === 'win32' ? process.env : undefined)
  if (!source) {
    return env
  }
  return composeAgentLaunchEnv({
    platform: 'win32',
    inherited: inheritedEnvLayer(source),
    agentEnv: env
  })
}

function deriveTarget(request: ResolveAgentLaunchRequest): LaunchTarget {
  return {
    platform: request.platform,
    execution: request.executionHostId.startsWith('wsl:') ? 'wsl' : 'native',
    shell: resolveStartupShell(request.platform, request.shell),
    isRemote: request.isRemote,
    executionHostId: request.executionHostId
  }
}

/** A snapshot's structured argv re-quotes into any target shell except `cmd`,
 *  whose double-quoted form cannot faithfully deliver `% ! ^ "`. A shell change is
 *  therefore lossless unless a captured element is unencodable in the new shell. */
function snapshotArgvEncodableInShell(
  snapshot: AgentLaunchSnapshot,
  shell: AgentStartupShell
): boolean {
  if (shell !== 'cmd') {
    return true
  }
  return !snapshot.argv.some((element) => CMD_UNENCODABLE_CHAR_RE.test(element))
}

function targetMatchesSnapshot(target: LaunchTarget, snapshot: AgentLaunchSnapshot): boolean {
  // Shell equality is not required: the snapshot stores structured argv, so a
  // shell change replays whenever every element re-encodes losslessly in the new
  // shell. Local-provider↔daemon needs no special case — both resolve to the same
  // executionHostId, which is not part of command semantics.
  return (
    snapshot.target.platform === target.platform &&
    snapshot.target.execution === target.execution &&
    snapshot.target.isRemote === target.isRemote &&
    snapshot.target.executionHostId === target.executionHostId &&
    snapshotArgvEncodableInShell(snapshot, target.shell)
  )
}

/** Replay a validated snapshot: argv/env come from the immutable snapshot, not
 *  the current definition. Fails closed on identity/target mismatch, and carries
 *  `snapshot_definition_changed` when the current effective definition drifted.  */
function replayFromSnapshot(
  request: ResolveAgentLaunchRequest,
  target: LaunchTarget,
  catalog: AgentCatalog,
  settings: GlobalSettings,
  inheritedEnv: NodeJS.ProcessEnv | undefined
): ResolveAgentLaunchOutcome {
  const snapshot = request.persistedSnapshot
  if (!snapshot) {
    return { ok: false, failure: { code: 'invalid_launch_snapshot' } }
  }
  if (request.selection.kind === 'agent' && request.selection.agent !== snapshot.requestedAgent) {
    return { ok: false, failure: { code: 'invalid_launch_snapshot', reason: 'identity_mismatch' } }
  }
  if (!targetMatchesSnapshot(target, snapshot)) {
    return { ok: false, failure: { code: 'invalid_launch_snapshot' } }
  }
  const client = clientOfIntent(request.intent)
  const comparisonInput = {
    snapshot,
    catalog,
    settings,
    target,
    client,
    variables: request.variables,
    targetHomePath: request.targetHomePath ?? null
  }
  const env = Object.create(null) as Record<string, string>
  let envWithheld = false
  if (client === 'mobile' || client === 'paired-web') {
    // Remove-only replay (§581): withhold any captured entry the current live
    // definition no longer authorizes (opt-out, removed key, rotated value,
    // deleted def) — never substitute current values or add new ones.
    const replayEnv = resolveMobileRemoveOnlyReplayEnv(comparisonInput)
    Object.assign(env, replayEnv.env)
    envWithheld = replayEnv.withheld
  } else {
    // Desktop/host replay copies the captured env unchanged.
    for (const key of Object.keys(snapshot.agentEnv)) {
      env[key] = snapshot.agentEnv[key]
    }
  }
  // Confidential transport is a current gate that constrains replay: captured
  // env never crosses hosts on an authenticated-but-plaintext channel. A remote
  // target must prove confidentiality (=== true); an unset capability on a remote
  // surface fails closed rather than replaying env over a possibly-plaintext link.
  const replayConfidentialityUnproven =
    request.transportConfidentialityAvailable === false ||
    (request.isRemote && request.transportConfidentialityAvailable === undefined)
  if (Object.keys(env).length > 0 && replayConfidentialityUnproven) {
    return {
      ok: false,
      failure: {
        code: 'secure_env_transport_unavailable',
        requestedAgent: snapshot.requestedAgent,
        baseAgent: snapshot.baseAgent
      }
    }
  }
  // Append the provider resume flags to the replayed base argv, derived from the
  // record's session (never persisted in the snapshot). A resume against a
  // non-resumable base or a session whose key type does not match the base cannot
  // produce a valid resume command, so it invalidates the replay.
  let resumeArgvSuffix: readonly string[] | undefined
  if (request.resumeProviderSession) {
    if (!isResumableTuiAgent(snapshot.baseAgent)) {
      return { ok: false, failure: { code: 'invalid_launch_snapshot' } }
    }
    const resumeArgv = getAgentResumeArgv(snapshot.baseAgent, request.resumeProviderSession)
    if (!resumeArgv) {
      return { ok: false, failure: { code: 'invalid_launch_snapshot' } }
    }
    resumeArgvSuffix = resumeArgv.slice(1)
  }
  // A resume suffix (provider session id / transcript path) carrying a
  // cmd-unencodable char would re-split the cmd command line (injection). It is
  // essential to a resume so it can't be dropped like a prompt — fail closed.
  if (
    resumeArgvSuffix &&
    target.shell === 'cmd' &&
    resumeArgvSuffix.some((element) => CMD_UNENCODABLE_CHAR_RE.test(element))
  ) {
    return { ok: false, failure: { code: 'invalid_launch_snapshot' } }
  }
  // Replay must re-run the caps: a shell change since capture (e.g. powershell→cmd
  // on win32) can lower the command-line/env ceiling below what the captured argv
  // plus resume suffix now encodes, and that must surface as the typed cap failure
  // rather than an opaque writer error at spawn.
  const replayArgv = (resumeArgvSuffix
    ? [...snapshot.argv, ...resumeArgvSuffix]
    : [...snapshot.argv]) as unknown as typeof snapshot.argv
  const replayCommandCap = checkCommandTooLong(replayArgv, target.shell)
  if (replayCommandCap) {
    return { ok: false, failure: replayCommandCap }
  }
  const replayEnvCap = checkEnvPayloadTooLarge(
    replayArgv,
    spawnEnvForPayloadCap(env, target, inheritedEnv),
    target
  )
  if (replayEnvCap) {
    return { ok: false, failure: replayEnvCap }
  }
  const definitionNotice = snapshotDefinitionChangedNotice(comparisonInput)
  const notices: AgentLaunchNotice[] = []
  if (definitionNotice) {
    notices.push(definitionNotice)
  }
  if (envWithheld) {
    // One generic notice for any mobile/paired remove-only withholding; it names
    // no keys/values (secrets rule).
    notices.push({ code: 'env_withheld', label: snapshot.displayLabel })
  }
  return {
    ok: true,
    launch: buildResolvedLaunch({
      mode: snapshot.mode,
      requestedAgent: snapshot.requestedAgent,
      baseAgent: snapshot.baseAgent,
      displayLabel: snapshot.displayLabel,
      argv: [...snapshot.argv] as unknown as typeof snapshot.argv,
      ...(resumeArgvSuffix ? { resumeArgvSuffix } : {}),
      env,
      envPolicy: Object.keys(env).length > 0 ? 'full' : 'none',
      referenced: [],
      values: { repoPath: null, worktreePath: null },
      notices,
      target,
      targetHomePath: request.targetHomePath ?? null,
      intentKind: request.intent.kind,
      client,
      config: TUI_AGENT_CONFIG[snapshot.baseAgent],
      basis: 'snapshot',
      definitionDigestSource: { replaySnapshot: snapshot.argv },
      transportConfidential: request.transportConfidentialityAvailable ?? null
    })
  }
}

/** Resolve a launch request against the normalized catalog and current settings.
 *  `inheritedEnv` is the layer the spawn will inherit, needed only to size a
 *  native-Windows environment block; it defaults to this process' env, which is
 *  that layer whenever this host is the one spawning. */
export function resolveAgentLaunch(
  request: ResolveAgentLaunchRequest,
  catalog: AgentCatalog,
  settings: GlobalSettings,
  inheritedEnv?: NodeJS.ProcessEnv
): ResolveAgentLaunchOutcome {
  const selection = resolveSelection(request, catalog)
  if (selection.kind === 'failure') {
    return { ok: false, failure: selection.failure }
  }
  if (selection.kind === 'request-error') {
    return { ok: false, requestError: selection.requestError }
  }

  const target = deriveTarget(request)

  if (selection.decision.launch === 'replay-snapshot') {
    return replayFromSnapshot(request, target, catalog, settings, inheritedEnv)
  }

  const client = clientOfIntent(request.intent)
  const context = buildLaunchContext(selection.decision, catalog, settings, client)
  const values = prepareVariableValues(request.variables, target.execution)

  // Env may cross to a different terminal host only inside an authenticated,
  // confidential channel; it never downgrades to plaintext or silently drops
  // values. Env-free launches may continue over a non-confidential channel. A
  // remote target must PROVE confidentiality (=== true): an unset capability on a
  // remote surface fails closed rather than shipping env over a possibly-plaintext
  // channel; local targets are trusted when the field is absent.
  const confidentialityUnproven =
    request.transportConfidentialityAvailable === false ||
    (request.isRemote && request.transportConfidentialityAvailable === undefined)
  if (Object.keys(context.env).length > 0 && confidentialityUnproven) {
    return {
      ok: false,
      failure: {
        code: 'secure_env_transport_unavailable',
        requestedAgent: context.requestedAgent,
        baseAgent: context.baseAgent
      }
    }
  }

  const command = assembleCommand({
    config: context.config,
    platform: request.platform,
    isRemote: request.isRemote,
    shell: target.shell,
    targetHomePath: request.targetHomePath ?? null,
    commandOverride: context.commandOverride,
    prefixOverride: context.prefixOverride,
    argsTemplate: context.argsTemplate,
    isCustomArgs: context.isCustomArgs,
    ...(request.perLaunchArgs !== undefined ? { perLaunchArgs: request.perLaunchArgs } : {}),
    envValues: Object.keys(context.env).map((key) => context.env[key]),
    values
  })
  if (!command.ok) {
    return { ok: false, failure: command.failure }
  }

  // Env values support the same {repoPath}/{worktreePath} tokens as argv (the
  // authoring UI offers them as insert targets and the requirement scan already
  // treats an env-only reference as required). Substitute them here — the raw map
  // was flowing verbatim into the spawn env, so `FOO={worktreePath}` launched with
  // the literal token. Interpolation is idempotent on values without tokens.
  const resolvedEnv: Record<string, string> = {}
  for (const key of Object.keys(context.env)) {
    resolvedEnv[key] = interpolateVariables(context.env[key], values)
  }

  // Stock-name detection gates only stock catalog argv with no accepted user PATH
  // override; configured/custom prefixes and custom PATH env cannot be evaluated
  // by name detection and proceed straight to spawn — no executable-existence
  // preflight exists, so for those rows the launch itself is the availability
  // check ('launch-reported' in the catalog projection).
  if (
    command.prefixSource === 'catalog' &&
    request.detectedStockBaseAgents !== null &&
    !request.detectedStockBaseAgents.has(context.baseAgent) &&
    !hasUserPathOverride(context.env)
  ) {
    return { ok: false, failure: { code: 'base_agent_unavailable', baseAgent: context.baseAgent } }
  }

  const commandCap = checkCommandTooLong(command.argv, target.shell)
  if (commandCap) {
    return { ok: false, failure: commandCap }
  }
  const envCap = checkEnvPayloadTooLarge(
    command.argv,
    spawnEnvForPayloadCap(resolvedEnv, target, inheritedEnv),
    target
  )
  if (envCap) {
    return { ok: false, failure: envCap }
  }

  return {
    ok: true,
    launch: buildResolvedLaunch({
      mode: context.mode,
      requestedAgent: context.requestedAgent,
      baseAgent: context.baseAgent,
      displayLabel: context.displayLabel,
      argv: command.argv,
      env: resolvedEnv,
      envPolicy: context.envPolicy,
      referenced: command.referenced,
      values,
      notices: context.notices,
      target,
      targetHomePath: request.targetHomePath ?? null,
      intentKind: request.intent.kind,
      client,
      config: context.config,
      basis: selection.basis,
      definitionDigestSource: context.definitionDigestSource,
      transportConfidential: request.transportConfidentialityAvailable ?? null
    })
  }
}
