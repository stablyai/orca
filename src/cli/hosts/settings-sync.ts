import type { CommandHandler } from '../dispatch/dispatch'
import { printResult } from '../output/command-result-output'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/types'
import { callerOrcaClient } from '../workspaces/worktree-parent-fields'
import type { RuntimeRpcSuccess } from '../../shared/runtime-rpc-envelope'
import type { PortableSettings, PortableSettingsImportResult } from '../../shared/portable-settings'

type SettingsSide = { client: RuntimeClient; label: string }

type SettingsCopyResult = PortableSettingsImportResult & { to: string; dryRun: boolean }

export const SETTINGS_SYNC_HANDLERS: Record<string, CommandHandler> = {
  'settings push': async ({ client, flags, json }) => {
    const [here, paired] = settingsSides(client)
    await copySettings(here, paired, flags.get('dry-run') === true, json)
  },
  'settings pull': async ({ client, flags, json }) => {
    const [here, paired] = settingsSides(client)
    await copySettings(paired, here, flags.get('dry-run') === true, json)
  }
}

function settingsSides(client: RuntimeClient): [SettingsSide, SettingsSide] {
  if (!client.isRemote) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Name the paired Orca to copy settings with: --environment <name>.'
    )
  }
  return [
    { client: callerOrcaClient(client), label: 'this computer' },
    { client, label: client.environmentSelector ?? 'the paired Orca' }
  ]
}

async function copySettings(
  from: SettingsSide,
  to: SettingsSide,
  dryRun: boolean,
  json: boolean
): Promise<void> {
  const exported = await callSettingsSync<{ settings: PortableSettings }>(
    from,
    'settings.exportPortable'
  )
  const imported = await callSettingsSync<PortableSettingsImportResult>(
    to,
    'settings.importPortable',
    { settings: exported.result.settings, dryRun }
  )
  const response: RuntimeRpcSuccess<SettingsCopyResult> = {
    ...imported,
    result: { ...imported.result, to: to.label, dryRun }
  }
  printResult(response, json, formatSettingsCopy)
}

async function callSettingsSync<TResult>(
  side: SettingsSide,
  method: string,
  params?: unknown
): Promise<RuntimeRpcSuccess<TResult>> {
  try {
    return await side.client.call<TResult>(method, params)
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'incompatible_runtime',
        `Orca on ${side.label} cannot copy settings yet. Update Orca there and try again.`
      )
    }
    throw error
  }
}

function formatSettingsCopy(result: SettingsCopyResult): string {
  const lines =
    result.changed.length === 0
      ? [`Settings on ${result.to} already match.`]
      : [
          `${result.dryRun ? 'Would change' : 'Changed'} ${result.changed.length} ${
            result.changed.length === 1 ? 'setting' : 'settings'
          } on ${result.to}:`,
          ...result.changed.map((key) => `  ${key}`)
        ]
  if (result.skipped.length > 0) {
    lines.push(`Not copied by ${result.to}: ${result.skipped.join(', ')}`)
  }
  return lines.join('\n')
}
