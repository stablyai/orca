import { describe, expect, it, vi } from 'vitest'
import { parsePluginManifest } from '../../shared/plugins/manifest/plugin-manifest'
import { fingerprintPluginConsent } from '../../shared/plugins/approval/plugin-consent-fingerprint'
import {
  PLUGIN_APPROVAL_REQUIRED_CODE,
  PLUGIN_APPROVAL_STALE_CODE,
  PluginApprovalRequiredError
} from '../../shared/plugins/approval/plugin-cli-approval'
import type { PluginAuditEntry } from './plugin-audit-log'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { approvePluginFromCli, pluginCliApprovalRequest } from './plugin-cli-approval'

const CONTENT_HASH = `sha256-${'a'.repeat(64)}`

function plugin(raw: Record<string, unknown>, overrides: Partial<ValidDiscoveredPlugin> = {}) {
  const parsed = parsePluginManifest({
    manifestVersion: 2,
    id: 'demo',
    publisher: 'acme',
    name: 'Demo',
    version: '1.0.0',
    engines: { orca: '>=1.4.245' },
    ...raw
  })
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  const valid: ValidDiscoveredPlugin = {
    pluginKey: 'acme.demo',
    rootDir: '/plugins/acme.demo',
    manifest: parsed.manifest,
    consentFingerprint: fingerprintPluginConsent(parsed.manifest, CONTENT_HASH),
    contentHash: CONTENT_HASH,
    isDev: false,
    ...overrides
  }
  return valid
}

const WORKER = {
  execution: 'trusted-worker',
  pluginApi: 1,
  main: 'main.mjs',
  contributes: { commands: [{ id: 'ping', title: 'Ping' }] },
  capabilities: [{ kind: 'terminal:send' }]
}
const THEME = {
  execution: 'data',
  contributes: { themes: [{ id: 'dusk', title: 'Dusk', path: 'themes/dusk.json' }] }
}

function harness(target: ValidDiscoveredPlugin, consents: Record<string, string> = {}) {
  const audit: PluginAuditEntry[] = []
  const applyConsent = vi.fn().mockResolvedValue(undefined)
  const service = {
    findValidPlugin: (key: string) => (key === target.pluginKey ? target : null),
    options: { getPluginConsents: () => consents, getDisabledPlugins: () => [] },
    recordApprovalAudit: vi.fn(async (entry: PluginAuditEntry) => {
      audit.push(entry)
    })
  }
  const approve = (approvalFingerprint?: string) =>
    approvePluginFromCli({
      service,
      applyConsent,
      pluginKey: target.pluginKey,
      approvalFingerprint,
      action: 'enable',
      caller: { kind: 'local-cli' }
    })
  return { audit, applyConsent, approve }
}

async function rejection(promise: Promise<unknown>): Promise<PluginApprovalRequiredError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof PluginApprovalRequiredError) {
      return error
    }
    throw error
  }
  throw new Error('expected a rejection')
}

describe('approvePluginFromCli', () => {
  it('enables content-only plugins without a flag and audits it', async () => {
    const theme = plugin(THEME)
    const { approve, applyConsent, audit } = harness(theme)
    await expect(approve()).resolves.toBe('content-only')
    expect(applyConsent).toHaveBeenCalledWith({
      pluginKey: 'acme.demo',
      reviewedFingerprint: theme.consentFingerprint,
      decision: 'approve'
    })
    expect(audit.map((entry) => [entry.actor, entry.outcome])).toEqual([
      ['cli:local', 'attempt'],
      ['cli:local', 'ok']
    ])
  })

  it('refuses code without the flag and explains exactly what would be granted', async () => {
    const worker = plugin(WORKER)
    const { approve, applyConsent, audit } = harness(worker)
    const error = await rejection(approve())
    expect(error.code).toBe(PLUGIN_APPROVAL_REQUIRED_CODE)
    expect(error.data.grants.execution).toBe('trusted-worker')
    expect(error.data.grants.capabilities.map((capability) => capability.kind)).toEqual([
      'terminal:send'
    ])
    expect(error.data.approveFlag).toBe(`--approve ${error.data.approvalFingerprint}`)
    expect(error.message).toContain('Type and run commands in your terminals')
    expect(applyConsent).not.toHaveBeenCalled()
    expect(audit).toEqual([])
  })

  it('grants with the shown fingerprint and records that it was approved via CLI', async () => {
    const worker = plugin(WORKER)
    const { approve, applyConsent, audit } = harness(worker)
    const fingerprint = pluginCliApprovalRequest(worker, 'enable').approvalFingerprint
    await expect(approve(fingerprint)).resolves.toBe('approve-flag')
    expect(applyConsent).toHaveBeenCalledOnce()
    expect(audit.at(-1)).toMatchObject({
      actor: 'cli:local',
      method: 'plugins.approve',
      outcome: 'ok',
      summary: expect.stringContaining(`approved via CLI --approve ${fingerprint}`)
    })
  })

  it('rejects a fingerprint shown for another build, plugin or access set', async () => {
    const shown = pluginCliApprovalRequest(plugin(WORKER), 'enable').approvalFingerprint
    const variants = [
      plugin({ ...WORKER, version: '1.0.1' }),
      plugin(WORKER, { contentHash: `sha256-${'b'.repeat(64)}` }),
      plugin({ ...WORKER, capabilities: [{ kind: 'terminal:send' }, { kind: 'agent:read' }] }),
      plugin({ ...WORKER, id: 'other' }, { pluginKey: 'acme.other' })
    ]
    for (const variant of variants) {
      const { approve, applyConsent } = harness(variant)
      const error = await rejection(approve(shown))
      expect(error.code).toBe(PLUGIN_APPROVAL_STALE_CODE)
      expect(error.data.approvalFingerprint).not.toBe(shown)
      expect(applyConsent).not.toHaveBeenCalled()
    }
  })

  it('needs no flag when the current access is already approved', async () => {
    const worker = plugin(WORKER)
    const { approve, applyConsent } = harness(worker, { 'acme.demo': worker.consentFingerprint })
    await expect(approve()).resolves.toBe('already-approved')
    expect(applyConsent).not.toHaveBeenCalled()
  })

  it('tells a development folder approval that later code edits are not re-reviewed', () => {
    const request = pluginCliApprovalRequest(
      plugin(WORKER, { isDev: true, contentHash: null, consentContentHash: 'dev-identity' }),
      'dev-load'
    )
    expect(request.contentIdentity).toBe('dev-identity')
    expect(request.why).toContain('Later code edits in this development folder')
  })
})
