import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  normalizeHerdrBinarySource,
  type HerdrBinarySource
} from '../../../../shared/terminal-backend'
import { HerdrRuntimeError } from './herdr-runtime-contract'

type HerdrSettings = Pick<GlobalSettings, 'herdrBinarySource' | 'hostSettingOverrides'>

export function resolveHerdrBinarySource(
  settings: HerdrSettings,
  hostId: ExecutionHostId
): HerdrBinarySource {
  return normalizeHerdrBinarySource(
    settings.hostSettingOverrides?.[hostId]?.herdrBinarySource ?? settings.herdrBinarySource
  )
}

export function resolveHerdrExecutable(
  source: HerdrBinarySource,
  platform: NodeJS.Platform = process.platform
): string {
  if (source.kind === 'custom') {
    const customPath = source.path.trim()
    if (!customPath) {
      throw new HerdrRuntimeError('herdr_unavailable', 'Custom Herdr path is empty')
    }
    return customPath
  }
  return platform === 'win32' ? 'herdr.exe' : 'herdr'
}
