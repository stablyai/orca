import type { FileExplorerRow } from './file-tree'
import type { UploadRow } from './mobile-file-explorer-upload-queue'

/** An upload shown inside the folder it goes to, until the real row replaces it. */
export type UploadNode = {
  id: string
  relativePath: string
  depth: number
  kind: 'upload'
  upload: UploadRow
}

/** Each upload sits first inside its folder: right under an open folder's row, or at the top for the root. */
export function withUploadRows(
  rows: FileExplorerRow[],
  uploads: readonly UploadRow[],
  expanded: ReadonlySet<string>
): FileExplorerRow[] {
  if (uploads.length === 0) {
    return rows
  }
  const node = (upload: UploadRow, depth: number): UploadNode => ({
    id: `upload:${upload.id}`,
    relativePath: upload.parent ? `${upload.parent}/${upload.name}` : upload.name,
    depth,
    kind: 'upload',
    upload
  })
  const merged: FileExplorerRow[] = uploads
    .filter((upload) => upload.parent === '')
    .map((upload) => node(upload, 0))
  for (const row of rows) {
    merged.push(row)
    if (row.kind === 'directory' && expanded.has(row.relativePath)) {
      for (const upload of uploads) {
        if (upload.parent === row.relativePath) {
          merged.push(node(upload, row.depth + 1))
        }
      }
    }
  }
  return merged
}
