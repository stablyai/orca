import { joinUri } from './generation-cache-uri'
import type { GenerationFileSystem } from './generation-store-file-system'

// One pass, then the old root goes: an entry that fails to move costs one download, and nothing old can return
// after a later delete or cap. An entry already here wins over its old copy.
export async function adoptLegacyRoot(
  fs: GenerationFileSystem,
  legacyRootUri: string
): Promise<void> {
  const legacy = await fs.list(legacyRootUri)
  if (legacy.length === 0) {
    return
  }
  await fs.createDirectory(fs.rootUri)
  const present = new Set((await fs.list(fs.rootUri)).map((entry) => entry.name))
  for (const entry of legacy) {
    if (present.has(entry.name)) {
      continue
    }
    const from = joinUri(legacyRootUri, entry.name)
    const to = joinUri(fs.rootUri, entry.name)
    await (entry.isDirectory ? fs.moveDirectory(from, to) : fs.moveFile(from, to)).catch(
      () => undefined
    )
  }
  await fs.delete(legacyRootUri)
}
