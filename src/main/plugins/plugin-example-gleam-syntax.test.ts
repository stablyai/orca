import { join } from 'node:path'
import { PLUGIN_SCHEMA_NEWEST_SINCE } from '../../shared/plugins/installation/plugin-host-version'
import { expect, it } from 'vitest'
import { fingerprintPluginConsent } from '../../shared/plugins/approval/plugin-consent-fingerprint'
import { PluginContentVerifier } from './plugin-content-integrity'
import { inspectPluginInstallTree } from './installation/plugin-install-staging'
import { PluginSyntaxRegistry } from './contributions/plugin-syntax-registry'

const root = join(process.cwd(), 'examples', 'plugins', 'orca-gleam-syntax')

it('ships an installable Gleam syntax pack whose grammar loads', async () => {
  const inspection = await inspectPluginInstallTree({
    rootDir: root,
    hostVersion: PLUGIN_SCHEMA_NEWEST_SINCE,
    identity: { pluginKey: 'stablyai.orca-gleam-syntax' }
  })
  expect(inspection).toMatchObject({ ok: true })
  if (!inspection.ok) {
    return
  }
  expect(inspection.manifest).toMatchObject({ manifestVersion: 2, execution: 'data' })

  const registry = new PluginSyntaxRegistry(new PluginContentVerifier())
  await registry.reconcile(
    [
      {
        pluginKey: 'stablyai.orca-gleam-syntax',
        rootDir: root,
        manifest: inspection.manifest,
        consentFingerprint: fingerprintPluginConsent(inspection.manifest),
        contentHash: null,
        isDev: true
      }
    ],
    () => true
  )
  expect(registry.error('stablyai.orca-gleam-syntax')).toBeNull()
  expect(registry.list()).toEqual([
    expect.objectContaining({
      id: 'plugin:stablyai.orca-gleam-syntax/gleam',
      extensions: ['.gleam']
    })
  ])
  expect(registry.load('plugin:stablyai.orca-gleam-syntax/gleam')).toMatchObject({
    scopeName: 'source.gleam',
    configuration: { comments: { lineComment: '//' } }
  })
})
