import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS } from '../session/mobile-clipboard-image-upload-chunk'
import { captureMobileFileMutationOwnership } from './mobile-file-mutation-ownership'

const statFile = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.workspace-save-stat',
    method: 'files.stat',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('workspace-save-stat', z.unknown())
  })
)

// A non-append chunk creates the file exclusively and its parent folders; append chunks extend it.
const writeChunk = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.workspace-save-chunk',
    method: 'files.writeBase64Chunk',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('workspace-save-chunk', z.unknown())
  })
)

export type MobileWorkspaceFileSaveSender = Parameters<typeof writeChunk.request>[0]

const MAX_NAME_ATTEMPTS = 50
const OPTIONS = { failWhenDisconnected: true, timeoutMs: 30_000 }

// One path segment: no separators, and never . or .. which would leave the folder.
function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/\0]/g, '_').trim()
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'shared-file' : cleaned
}

// paper.pdf, paper (2).pdf, paper (3).pdf, …
function numberedFileName(name: string, attempt: number): string {
  if (attempt === 1) {
    return name
  }
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)} (${attempt})${name.slice(dot)}` : `${name} (${attempt})`
}

// Saves bytes into the workspace under the first free name in `directory`, never overwriting.
// Resolves the workspace-relative path it wrote.
export async function saveMobileWorkspaceFile(
  client: MobileWorkspaceFileSaveSender,
  file: { worktreeId: string; directory: string; name: string; base64: string }
): Promise<string> {
  const worktree = `id:${file.worktreeId}`
  const name = safeFileName(file.name)
  // The host refuses file mutations that don't name the host they expect to write on.
  const ownership = await captureMobileFileMutationOwnership(client, worktree)
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const relativePath = `${file.directory}/${numberedFileName(name, attempt)}`
    // ponytail: stat-then-create can race another writer; the exclusive create then fails the save rather than overwrite.
    if ((await statFile.request(client, { worktree, relativePath }, OPTIONS)).ok) {
      continue
    }
    // Chunk on four-character boundaries so each piece decodes on its own.
    let offset = 0
    do {
      writeChunk.interpret(
        await writeChunk.request(
          client,
          {
            worktree,
            relativePath,
            contentBase64: file.base64.slice(
              offset,
              offset + MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
            ),
            append: offset > 0,
            ...ownership
          },
          OPTIONS
        )
      )
      offset += MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
    } while (offset < file.base64.length)
    return relativePath
  }
  throw new Error(`no free name for ${name} in ${file.directory}`)
}
