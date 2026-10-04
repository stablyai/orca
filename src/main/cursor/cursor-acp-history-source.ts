import { readAuthorizedDocPreviewFile } from '../../shared/doc-preview-file-access'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'

const metadataSchema = z.object({
  schemaVersion: z.literal(1),
  cwd: z.string().min(1).max(4096).refine(isAbsolute)
})

/** ACP stores are separate from Cursor's terminal chats; never substitute one for the other. */
type CursorAcpHistorySourceInput = {
  accountHomePath: string
  providerSessionId: string
  cwd: string
  signal?: AbortSignal
  timeoutMs?: number
}

export async function resolveCursorAcpHistorySource(
  input: CursorAcpHistorySourceInput
): Promise<string | null> {
  if (input.signal?.aborted) {
    return null
  }
  const work = withTimeout(
    resolveOwnedCursorAcpHistorySource(input),
    Math.min(2000, Math.max(1, input.timeoutMs ?? 2000)),
    null
  )
  if (!input.signal) {
    return work
  }
  let cancel = () => {}
  const aborted = new Promise<null>((resolve) => {
    cancel = () => resolve(null)
  })
  input.signal.addEventListener('abort', cancel, { once: true })
  try {
    return await Promise.race([work, aborted])
  } finally {
    input.signal.removeEventListener('abort', cancel)
  }
}

async function resolveOwnedCursorAcpHistorySource(
  input: CursorAcpHistorySourceInput
): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(input.providerSessionId) || !isAbsolute(input.cwd)) {
    return null
  }
  const directory = join(input.accountHomePath, 'acp-sessions', input.providerSessionId)
  const database = join(directory, 'store.db')
  const metadata = join(directory, 'meta.json')
  try {
    const root = await realpath(join(input.accountHomePath, 'acp-sessions'))
    const ownedDirectory = await realpath(directory)
    if (dirname(ownedDirectory) !== root || basename(ownedDirectory) !== input.providerSessionId) {
      return null
    }
    const [databaseInfo, metadataInfo] = await Promise.all([stat(database), stat(metadata)])
    if (!databaseInfo.isFile() || !metadataInfo.isFile() || metadataInfo.size > 64 * 1024) {
      return null
    }
    if (
      dirname(await realpath(database)) !== ownedDirectory ||
      dirname(await realpath(metadata)) !== ownedDirectory
    ) {
      return null
    }
    const opened = await readAuthorizedDocPreviewFile({
      boundaryPath: ownedDirectory,
      entryPath: metadata,
      implicitRootPath: null,
      authorizedRootPaths: [],
      targetPath: metadata,
      maxTextBytes: 64 * 1024,
      maxBinaryBytes: 64 * 1024
    })
    if (opened.isBinary || input.signal?.aborted) {
      return null
    }
    const saved = metadataSchema.safeParse(JSON.parse(opened.content))
    if (
      !saved.success ||
      normalizeRuntimePathForComparison(resolve(saved.data.cwd)) !==
        normalizeRuntimePathForComparison(resolve(input.cwd))
    ) {
      return null
    }
    return database
  } catch {
    return null
  }
}
