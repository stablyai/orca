import {
  buildPluginApprovalRequest,
  pluginApprovalFingerprint,
  PluginApprovalRequiredError,
  pluginNeedsCliApproval,
  PluginNotFoundError,
  type PluginApprovalAction
} from '../../shared/plugins/approval/plugin-cli-approval'
import type { PluginConsentRequest } from '../../shared/plugins/approval/plugin-consent-request'
import type { RpcCallerIdentity } from '../runtime/rpc/rpc-caller-identity'
import type { PluginAuditEntry } from './plugin-audit-log'
import type { ValidDiscoveredPlugin } from './plugin-discovery'

export type PluginCliApprovalService = {
  findValidPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
  options: {
    getPluginConsents: () => Record<string, string>
    getDisabledPlugins: () => string[]
  }
  recordApprovalAudit: (entry: PluginAuditEntry) => Promise<void>
}

export type PluginCliApprovalOutcome = 'content-only' | 'approve-flag' | 'already-approved'

function contentIdentity(plugin: ValidDiscoveredPlugin): string {
  return plugin.contentHash ?? plugin.consentContentHash ?? `dev:${plugin.rootDir}`
}

function subject(plugin: ValidDiscoveredPlugin) {
  return {
    pluginKey: plugin.pluginKey,
    manifest: plugin.manifest,
    consentFingerprint: plugin.consentFingerprint,
    contentIdentity: contentIdentity(plugin),
    isDev: plugin.isDev
  }
}

export function pluginCliApprovalRequest(
  plugin: ValidDiscoveredPlugin,
  action: PluginApprovalAction
) {
  return buildPluginApprovalRequest(subject(plugin), action)
}

export function pluginCliAuditActor(caller: RpcCallerIdentity | undefined): `cli:${string}` {
  if (!caller) {
    return 'cli:unknown'
  }
  switch (caller.kind) {
    case 'local-cli':
      return 'cli:local'
    case 'paired-device':
      return `cli:paired-device:${caller.deviceId}`
    case 'desktop':
      return 'cli:desktop'
  }
}

/**
 * The only RPC path that grants a plugin access. Content-only plugins pass; anything that runs
 * code or acts needs the fingerprint from a prior `approval_required`, and every grant is audited.
 */
export async function approvePluginFromCli(input: {
  service: PluginCliApprovalService
  applyConsent: (request: PluginConsentRequest) => Promise<void>
  pluginKey: string
  approvalFingerprint?: string
  action: PluginApprovalAction
  caller: RpcCallerIdentity | undefined
}): Promise<PluginCliApprovalOutcome> {
  const plugin = input.service.findValidPlugin(input.pluginKey)
  if (!plugin) {
    throw new PluginNotFoundError(input.pluginKey)
  }
  const consented =
    input.service.options.getPluginConsents()[plugin.pluginKey] === plugin.consentFingerprint
  const disabled = input.service.options.getDisabledPlugins().includes(plugin.pluginKey)
  if (consented && !disabled) {
    return 'already-approved'
  }
  const needsFlag = pluginNeedsCliApproval(plugin.manifest)
  if (needsFlag) {
    const request = pluginCliApprovalRequest(plugin, input.action)
    if (input.approvalFingerprint === undefined) {
      throw new PluginApprovalRequiredError(request)
    }
    if (input.approvalFingerprint !== pluginApprovalFingerprint(subject(plugin))) {
      throw new PluginApprovalRequiredError(request, true)
    }
  }
  const actor = pluginCliAuditActor(input.caller)
  const summary = needsFlag
    ? `${plugin.pluginKey}@${plugin.manifest.version} approved via CLI --approve ${input.approvalFingerprint} (${input.action})`
    : `${plugin.pluginKey}@${plugin.manifest.version} content-only plugin enabled via CLI (${input.action})`
  // Why before the write: a failed audit append must not leave an unlogged grant.
  await input.service.recordApprovalAudit({
    ts: Date.now(),
    actor,
    method: 'plugins.approve',
    summary,
    outcome: 'attempt'
  })
  try {
    await input.applyConsent({
      pluginKey: plugin.pluginKey,
      reviewedFingerprint: plugin.consentFingerprint,
      decision: 'approve'
    })
  } catch (error) {
    await input.service
      .recordApprovalAudit({
        ts: Date.now(),
        actor,
        method: 'plugins.approve',
        summary,
        outcome: 'error'
      })
      .catch(() => undefined)
    throw error
  }
  await input.service.recordApprovalAudit({
    ts: Date.now(),
    actor,
    method: 'plugins.approve',
    summary,
    outcome: 'ok'
  })
  return needsFlag ? 'approve-flag' : 'content-only'
}
