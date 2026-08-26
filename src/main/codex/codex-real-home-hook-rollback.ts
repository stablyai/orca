import { restoreCodexTrustFilesIfUnchanged } from './codex-trust-config-generation'
import type { CodexTrustConfigSnapshot } from './codex-trust-config-rollback'

export function restoreRealHomeTrustFilesIfUnchanged(args: {
  hooksJsonPath: string
  hooksSnapshot: CodexTrustConfigSnapshot
  hooksAfterMutation: CodexTrustConfigSnapshot
  configTomlPath: string
  configSnapshot: CodexTrustConfigSnapshot | null
  configAfterMutation: CodexTrustConfigSnapshot
}): boolean {
  const files = [
    {
      path: args.hooksJsonPath,
      snapshot: args.hooksSnapshot,
      expectedCurrent: args.hooksAfterMutation
    }
  ]
  if (args.configSnapshot) {
    files.push({
      path: args.configTomlPath,
      snapshot: args.configSnapshot,
      expectedCurrent: args.configAfterMutation
    })
  }
  return restoreCodexTrustFilesIfUnchanged(files)
}
