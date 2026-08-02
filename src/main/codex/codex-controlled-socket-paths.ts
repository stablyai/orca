import { createHash } from 'node:crypto'
import { isAbsolute, join, parse, resolve } from 'node:path'

const SOCKET_PATH_LIMIT = 100

export function getControlledSocketRoot(configured?: string): string {
  const root = configured ?? process.env.ORCA_CONTROLLED_CODEX_SOCKET_ROOT
  if (root !== undefined) {
    if (!isAbsolute(root) || resolve(root) === parse(root).root) {
      throw new Error('controlled Codex socket root must be an absolute private directory')
    }
    return root
  }
  return join('/tmp', `ocw-${process.getuid?.() ?? 'local'}`)
}

export function getControlledSocketPath(root: string, conversationId: string): string {
  const digest = createHash('sha256').update(conversationId).digest('hex').slice(0, 16)
  const path = join(root, `${digest}.sock`)
  if (Buffer.byteLength(path) > SOCKET_PATH_LIMIT) {
    throw new Error('controlled Codex Unix socket path exceeds the local platform limit')
  }
  return path
}

export function getControlledStatePath(root: string, conversationId: string): string {
  const digest = createHash('sha256').update(conversationId).digest('hex')
  return join(root, `${digest}.json`)
}
