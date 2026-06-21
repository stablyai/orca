export function resolveMobileWorkspaceCreateName(args: {
  draft: string | undefined
  fallback: string
}): string {
  return args.draft?.trim() || args.fallback
}

// Why: mirrors the desktop issue-name slugger so contractions do not create
// branch/path names like `can-t-enable` in mobile-created workspaces.
function removeIntraWordApostrophes(input: string): string {
  return input.replace(/[‘’]/g, "'").replace(/([\p{L}\p{N}])'(?=[\p{L}\p{N}])/gu, '$1')
}

function slugifyForWorkspaceName(input: string): string {
  return removeIntraWordApostrophes(input)
    .trim()
    .toLowerCase()
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 48)
    .replace(/[-._]+$/g, '')
}

export function getLinkedWorkItemSuggestedName(item: { title: string }): string {
  const withoutLeadingNumber = item.title
    .trim()
    .replace(/^(?:issue|pr|pull request)\s*#?\d+\s*[:-]\s*/i, '')
    .replace(/^#\d+\s*[:-]\s*/, '')
    .replace(/\(#\d+\)/gi, '')
    .replace(/\b#\d+\b/g, '')
    .trim()
  const seed = withoutLeadingNumber || item.title.trim()
  return slugifyForWorkspaceName(seed)
}
