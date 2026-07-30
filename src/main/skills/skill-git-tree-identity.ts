import { createHash } from 'node:crypto'

/**
 * Git object identity for an observed skill package.
 *
 * The updater's lock records the git tree sha of the skill folder it installed,
 * so hashing the observed bytes the same way lets the post-run verdict recognise
 * content the bundled registry has never seen. The algorithm is a port of
 * `gitTreeSha` in config/scripts/generate-skill-bundle-manifest.mjs and must
 * match it exactly — a near-miss never matches anything and silently disables
 * the verdict's lock check.
 *
 * Hashes are over RAW bytes deliberately: a CRLF materialization (Windows
 * checkout) hashes differently from the source tree, so it fails closed to the
 * pre-lock-check behavior rather than misidentifying content.
 */

export type SkillGitTreeFileEntry = {
  /** Slash-separated path relative to the package root. */
  path: string
  executable: boolean
  blobSha: Buffer
}

type SkillGitTreeDirectory = {
  directories: Map<string, SkillGitTreeDirectory>
  files: { filename: string; executable: boolean; blobSha: Buffer }[]
}

function gitObjectSha(kind: 'blob' | 'tree', bytes: Buffer): Buffer {
  return createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest()
}

export function gitBlobSha(bytes: Buffer): Buffer {
  return gitObjectSha('blob', bytes)
}

export function skillPackageGitTreeSha(entries: readonly SkillGitTreeFileEntry[]): string {
  const root: SkillGitTreeDirectory = { directories: new Map(), files: [] }
  for (const entry of entries) {
    const parts = entry.path.split('/')
    const filename = parts.pop() as string
    let directory = root
    for (const part of parts) {
      let child = directory.directories.get(part)
      if (!child) {
        child = { directories: new Map(), files: [] }
        directory.directories.set(part, child)
      }
      directory = child
    }
    directory.files.push({ filename, executable: entry.executable, blobSha: entry.blobSha })
  }

  function hashDirectory(directory: SkillGitTreeDirectory): Buffer {
    const children = [
      ...[...directory.directories].map(([name, child]) => ({
        mode: '40000',
        name,
        hash: hashDirectory(child)
      })),
      ...directory.files.map((file) => ({
        mode: file.executable ? '100755' : '100644',
        name: file.filename,
        hash: file.blobSha
      }))
    ].sort((left, right) => {
      // Git orders tree entries as raw bytes with directory names read as `name/`.
      const leftName = left.mode === '40000' ? `${left.name}/` : left.name
      const rightName = right.mode === '40000' ? `${right.name}/` : right.name
      return Buffer.from(leftName).compare(Buffer.from(rightName))
    })
    const body = Buffer.concat(
      children.map(({ mode, name, hash }) =>
        Buffer.concat([Buffer.from(`${mode} ${name}\0`, 'utf8'), hash])
      )
    )
    return gitObjectSha('tree', body)
  }

  return hashDirectory(root).toString('hex')
}
