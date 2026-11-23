const CLAUDE_ARTIFACT_ENV = 'CLAUDE_CODE_ARTIFACT'

// SDK entrypoints hide Claude's Artifact tools unless this is set; a user value still wins,
// matched case-insensitively on Windows, where claude_code_artifact=0 is the same opt-out.
export function withClaudeArtifactDefault(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const chosen = Object.keys(env).some(
    (key) =>
      key === CLAUDE_ARTIFACT_ENV ||
      (platform === 'win32' && key.toUpperCase() === CLAUDE_ARTIFACT_ENV)
  )
  return chosen ? env : { ...env, [CLAUDE_ARTIFACT_ENV]: '1' }
}
