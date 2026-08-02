const REPO_COLOR_PALETTE = [
  '#f97316',
  '#8b5cf6',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
  '#f59e0b',
  '#6366f1'
]

export function repoColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  return REPO_COLOR_PALETTE[Math.abs(hash) % REPO_COLOR_PALETTE.length]!
}
