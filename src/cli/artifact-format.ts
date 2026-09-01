import type { ArtifactListItem, ArtifactListPage, ArtifactReadResult } from '../shared/artifacts'

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

export function formatArtifactRead(result: ArtifactReadResult): string {
  return result.content
}

export function sanitizeArtifactTerminalContent(content: string): string {
  const escape = String.fromCharCode(27)
  const osc = new RegExp(
    `${escape}\\][^${String.fromCharCode(7)}]*?(?:${String.fromCharCode(7)}|${escape}\\\\)`,
    'g'
  )
  const csi = new RegExp(`${escape}(?:\\[[0-9;?]*[ -/]*[@-~])`, 'g')
  return content
    .replace(osc, '')
    .replace(csi, '')
    .split('')
    .filter((char) => {
      const code = char.charCodeAt(0)
      return (
        (code >= 32 && code !== 127 && !(code >= 0x80 && code <= 0x9f)) || code === 9 || code === 10
      )
    })
    .join('')
}
