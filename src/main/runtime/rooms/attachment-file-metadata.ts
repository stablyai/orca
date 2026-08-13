import { extname } from 'node:path'

export function safeRoomAttachmentName(value: string): string {
  const cleaned = value.replace(/[\p{Cc}<>:"/\\|?*]/gu, '_').trim()
  return (cleaned || 'attachment').slice(0, 240)
}

export function roomAttachmentMimeType(fileName: string): string {
  const extension = extname(fileName).toLowerCase()
  return (
    (
      {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf',
        '.json': 'application/json',
        '.md': 'text/markdown',
        '.txt': 'text/plain'
      } as Record<string, string>
    )[extension] ?? 'application/octet-stream'
  )
}
