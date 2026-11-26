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
 * into a distro, drop the mark so the next pass resolves it and pauses (pending edits are kept).
 */
export function startCodexNativeSourceCheck(runtimeHomePath: string, systemTomlPath: string): void {
  if (pendingChecks.has(runtimeHomePath)) {
    return
  }
  pendingChecks.add(runtimeHomePath)
  void classifyHostSource(systemTomlPath)
    .then((outcome) => {
      pendingChecks.delete(runtimeHomePath)
      if (outcome !== 'native') {
        retireCodexNativeSourceMark(runtimeHomePath)
      }
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
