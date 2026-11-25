import { describe, expect, it } from 'vitest'
import {
  buildPluginApprovalRequest,
  PLUGIN_APPROVAL_REQUIRED_CODE,
  type PluginApprovalRequest
} from '../../../shared/plugins/approval/plugin-cli-approval'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import { updateAllApprovalError, type PluginCliUpdateAllResult } from './plugin-cli-update'

// Why data: a content-only plugin asks for nothing new, so only a move to another repository needs approval.
const manifest = pluginManifestSchema.parse({
  manifestVersion: 2,
  id: 'demo',
  publisher: 'samples',
  name: 'Demo',
  version: '1.1.0',
  execution: 'data',
  license: 'MIT',
  engines: { orca: '>=1.4.248' },
  capabilities: [],
  contributes: {}
})

function movedRequest(installed: boolean): PluginApprovalRequest {
  const request = buildPluginApprovalRequest(
    {
      pluginKey: 'samples.demo',
      manifest,
      consentFingerprint: 'fingerprint',
      contentIdentity: 'new-hash',
      isDev: false
    },
    'update',
    {
      update: {
        fromVersion: '1.0.0',
        growth: null,
        repositoryMoved: { from: 'github.com/old/demo', to: 'github.com/samples/demo' }
      }
    }
  )
  return installed ? { ...request, installed: { version: '1.1.0' } } : request
}

function resultWith(approvals: PluginApprovalRequest[]): PluginCliUpdateAllResult {
  return { updates: [], approvals, failed: [] }
}

describe('updateAllApprovalError', () => {
  it('says the version landed and only its approval is owed, with the actual reason', () => {
    const request = movedRequest(true)
    const error = updateAllApprovalError(resultWith([request]))

    expect(error?.code).toBe(PLUGIN_APPROVAL_REQUIRED_CODE)
    expect(error?.message).toBe(
      [
        '1 plugin update(s) installed, but their approval is still pending:',
        `- samples.demo 1.1.0 is installed. It now comes from a different repository: github.com/old/demo → github.com/samples/demo. Fingerprint: ${request.approvalFingerprint}`
      ].join('\n')
    )
    expect(error?.message).not.toContain('need approval before they install')
  })

  it('keeps the before-install wording for an update that has not landed', () => {
    const request = movedRequest(false)
    const error = updateAllApprovalError(resultWith([request]))

    expect(error?.message).toBe(
      [
        '1 plugin update(s) need approval before they install:',
        `- samples.demo 1.1.0: ${request.grants.executionDescription} Fingerprint: ${request.approvalFingerprint}`
      ].join('\n')
    )
  })

  it('lists landed and waiting updates in their own sections', () => {
    const landed = movedRequest(true)
    const waiting = movedRequest(false)
    const error = updateAllApprovalError(resultWith([landed, waiting]))

    expect(error?.message).toContain(
      '1 plugin update(s) need approval before they install:\n- samples.demo 1.1.0:'
    )
    expect(error?.message).toContain(
      `1 plugin update(s) installed, but their approval is still pending:\n- samples.demo 1.1.0 is installed. It now comes from a different repository: github.com/old/demo → github.com/samples/demo. Fingerprint: ${landed.approvalFingerprint}`
    )
  })
})
