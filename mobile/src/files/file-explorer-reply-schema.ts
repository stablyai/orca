import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'

// The Files tab's directory read and the capped list it falls back to. Checked against
// src/main/runtime/rpc/methods/files.ts:125 and :27, and the shared results they return:
// DirEntry rows from readFileExplorerDir, RuntimeFileListResult from listMobileFiles.

/**
 * One directory's entries.
 *
 * The payload is the array itself, and it is required: MobileFileExplorerPanel.tsx:157 puts it
 * straight into the directory cache, where flattenDirectoryCache (file-tree.ts:58) sorts and walks
 * it — a reply that was not an array was a `.filter` on a string one render later, with nothing
 * naming the reply.
 *
 * A row needs `name` and `isDirectory`, and a row without either drops rather than failing the
 * whole read, which is what a skip policy means for a directory listing: compareFileNames reads
 * `name` unguarded, and `isDirectory` is the discriminator the whole tree projection turns on, so a
 * row without it is a file that can never be opened and whose label renders `undefined`.
 * `isSymlink` is decoration on the row and stays salvaged.
 */
export const fileDirectoryEntriesSchema = salvagingArray(
  z.looseObject({
    name: z.string(),
    isDirectory: z.boolean(),
    isSymlink: salvagedOptional('isSymlink', z.boolean())
  })
)

/**
 * The capped flat list an older desktop answers when `files.readDir` is not allowlisted.
 *
 * `files` and `truncated` are both required and both read unguarded: directoryCacheFromFileList
 * walks `files` and splits each `relativePath` (file-list-fallback.ts:48), and
 * MobileFileExplorerPanel.tsx:136 publishes `truncated` into the state that draws the "Showing
 * first 5000" note. A row without a string `relativePath` drops — it can name no directory — where
 * main crashed the whole fallback on it.
 *
 * `basename` and `kind` are not declared: this consumer reads neither, and passthrough keeps them
 * for the inventory reader that does.
 */
export const legacyFileListSchema = z.looseObject({
  files: salvagingArray(z.looseObject({ relativePath: z.string() })),
  truncated: z.boolean()
})
