import type { ArtifactListItem, ArtifactListPage } from '../shared/artifacts'

export function formatArtifactList(artifacts: readonly ArtifactListItem[]): string {
  if (artifacts.length === 0) {
    return 'No shared artifacts.'
  }
  return artifacts
    .map(({ artifact, shareUrl }) => {
      const name = artifact.title || artifact.originalFileName || artifact.slug
      return `${name}\n  id: ${artifact.slug}\n  updated: ${artifact.updatedAt}\n  url: ${shareUrl}`
    })
    .join('\n\n')
}

export function formatArtifactListPage(page: ArtifactListPage): string {
  const rows = formatArtifactList(page.artifacts)
  return page.nextCursor ? `${rows}\nMore artifacts: --cursor ${page.nextCursor}` : rows
}

export function formatArtifactShared(item: ArtifactListItem): string {
  return item.shareUrl
}
