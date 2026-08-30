import { createHash } from 'node:crypto'

export function createPaperclipConnectionId(
  origin: string,
  companyId: string,
  projectId: string
): string {
  return createHash('sha256')
    .update(`${origin}\0${companyId}\0${projectId}`)
    .digest('hex')
    .slice(0, 24)
}
