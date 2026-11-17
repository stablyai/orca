// The source commit this runtime was built from, reported by status.get as `buildCommit`.
// Only orcad stamps it (orcad/orcad-build-commit.ts); other hosts leave it unset and report nothing.
const FULL_COMMIT = /^[0-9a-f]{40}$/

let buildCommit: string | null = null

export function setRuntimeBuildCommit(commit: string | null): void {
  const trimmed = commit?.trim().toLowerCase() ?? ''
  buildCommit = FULL_COMMIT.test(trimmed) ? trimmed : null
}

export function getRuntimeBuildCommit(): string | null {
  return buildCommit
}
