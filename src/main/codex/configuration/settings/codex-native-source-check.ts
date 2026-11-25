import { join } from 'node:path'
import { observeAgentStateFile } from '../codex-path-observation'
import { resolvesIntoWslShareAsync } from '../../../wsl/filesystem/wsl-share-path-resolution'
import { resolvePromotionWriteTargetAsync } from './config-settings-promotion-write-target'
import { retireCodexNativeSourceMark } from './config-settings-baseline'

const pendingChecks = new Set<string>()

/** While a check runs, passes for that home probe synchronously instead of trusting the mark. */
export function isCodexNativeSourceCheckPending(runtimeHomePath: string): boolean {
  return pendingChecks.has(runtimeHomePath)
}

/**
 * A clean pass trusted the native-source mark; confirm it off the hot path. If ~/.codex now leads
 * into a distro, record what that pass would have: no kept values, unless the managed copy changed
 * since, in which case only the mark goes and the next pass keeps its pending edits.
 */
export function startCodexNativeSourceCheck(
  runtimeHomePath: string,
  systemTomlPath: string,
  runtimeConfig: string | null
): void {
  if (pendingChecks.has(runtimeHomePath)) {
    return
  }
  pendingChecks.add(runtimeHomePath)
  void classifyHostSource(systemTomlPath)
    .then((outcome) => {
      pendingChecks.delete(runtimeHomePath)
      if (outcome === 'native') {
        return
      }
      const current = observeAgentStateFile(join(runtimeHomePath, 'config.toml'))
      const unchanged =
        current.kind === 'present' ? current.value === runtimeConfig : runtimeConfig === null
      retireCodexNativeSourceMark(runtimeHomePath, outcome === 'guest' && unchanged)
    })
    .catch((error: unknown) => {
      pendingChecks.delete(runtimeHomePath)
      console.warn('[codex-settings-promotion] failed to confirm the Codex config source', error)
    })
}

async function classifyHostSource(
  systemTomlPath: string
): Promise<'native' | 'guest' | 'unresolved'> {
  try {
    const target = await resolvePromotionWriteTargetAsync(systemTomlPath)
    return (await resolvesIntoWslShareAsync(target.path)) ? 'guest' : 'native'
  } catch {
    return 'unresolved'
  }
}
