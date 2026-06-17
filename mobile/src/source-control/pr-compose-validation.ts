// Ref normalizers ported from src/shared/hosted-review-refs.ts (value-imported, not
// referenced across the package boundary — Metro's resolver is rooted at mobile/ and
// can't bundle a runtime import from repo-root/src, unlike erased `import type`s).
// Keep in sync with the shared versions so mobile and desktop compare refs identically.
function normalizeHeadRef(ref: string): string {
  return ref
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\/[^/]+\//, '')
}

function normalizeBaseRef(ref: string): string {
  return normalizeHeadRef(ref).replace(/^(origin|upstream)\//, '')
}

// Submit-gating for the create-PR composer, matching desktop CreatePullRequestDialog:
// the base ref must be non-empty and must differ from the head branch after ref
// normalization (strip refs/heads, remote prefixes, origin/upstream), case-insensitive.
export function isBaseHeadDistinct(base: string, head: string): boolean {
  const b = normalizeBaseRef(base).toLowerCase()
  const h = normalizeHeadRef(head).toLowerCase()
  return b.length > 0 && b !== h
}

export function canSubmitPrCompose(title: string, base: string, head: string): boolean {
  return title.trim().length > 0 && isBaseHeadDistinct(base, head)
}
