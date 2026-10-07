import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// What a session file tab reads to render one document. Checked against
// src/main/runtime/rpc/methods/files.ts:70/104 and git-diff-methods.ts:16, and the shared results
// they return: RuntimeFileReadResult and RuntimeFilePreviewResult in runtime-file-contracts.ts,
// GitDiffTextResult / GitDiffBinaryResult in git-diff-compare-types.ts.
//
// A tab is stricter than the preview screen on the same two file methods, and that is a property of
// the consumer rather than of the host: resolveMobileFileTabDoc publishes what it reads straight
// into a typed ready document with no guard, where the preview screen normalizes every member.

/**
 * The text a file tab renders, from `files.read`.
 *
 * All three are required because all three are published unguarded into MobileFileTabDoc:
 * mobile-file-tab-doc.ts:68 renders `content` as the html body and :73-75 puts `content`,
 * `truncated` and `byteLength` into the `file` arm, whose size label and truncation banner read
 * them as a number and a boolean. A reply missing one rendered `undefined` in the tab. All three
 * are declared required by RuntimeFileReadResult, so no host that answers this method omits them.
 */
export const fileTabTextSchema = z.looseObject({
  content: z.string(),
  truncated: z.boolean(),
  byteLength: z.number()
})

/**
 * The image bytes a file tab renders, from `files.readPreview`.
 *
 * `content` is required: buildImageDataUri runs `base64Content.replace` with no guard once
 * `isImage` is truthy (mobile-file-tab-doc.ts:58), so a reply without a string content was a
 * TypeError. RuntimeFilePreviewResult declares it required.
 *
 * `mimeType` is a plain optional rather than a salvaged one, because main had no fallback for a
 * wrong type here either: `mimeType?.startsWith` threw on a non-string, and readFileTab's catch
 * showed "Couldn't load file preview". An incompatible reply reaches that same catch with that same
 * copy, where salvaging to absent would instead have shown 'Binary preview unavailable'.
 *
 * `isImage` stays `z.unknown()`: the tab gates on its truthiness, not on `=== true`, so narrowing
 * it to a boolean would drop an image main rendered.
 */
export const fileTabImageSchema = z.looseObject({
  content: z.string(),
  isImage: z.unknown().optional(),
  mimeType: z.string().optional()
})

/**
 * The text arm of `git.diff`: the only arm whose contents are read.
 *
 * Both sides are required because buildMobileDiffLines reads `content.length` on each with no
 * guard (mobile-diff-lines.ts:35), so a text diff missing one was a TypeError caught as
 * "Couldn't load diff preview".
 */
const fileTabTextDiffSchema = z.looseObject({
  kind: z.literal('text'),
  originalContent: z.string(),
  modifiedContent: z.string()
})

/**
 * Every other arm of `git.diff`, including one this build has not heard of.
 *
 * The arm set is a wire surface, so an unknown `kind` degrades here rather than refusing the reply:
 * mobile-file-tab-doc.ts:41 asks only `kind !== 'text'`, and an unknown arm took this branch on
 * main too. `kind` is therefore any string but `text` — routing an unreadable *text* diff here
 * instead would render "Binary preview unavailable" for a diff whose contents simply did not
 * arrive, which names the file rather than the reply.
 *
 * Nothing in the arm is required: mobileDiffImageDataUri guards every member it reads
 * (mobile-diff-image-preview.ts:22-33) and answers null — 'binary_file' — for anything it cannot
 * use. `isImage` and `modifiedDeleted` are `=== true` comparisons, so a salvaged member lands on
 * main's own arm; `mimeType` is a plain optional for the same reason the image tab's is.
 *
 * `kind` is admitted as any string but `text` and answered as `binary`, because that is the arm the
 * client resolved rather than the token the host sent: no consumer forwards or renders it, and
 * naming it `binary` is what lets the tab tell the two arms apart without re-testing the string.
 */
const fileTabBinaryDiffSchema = z.looseObject({
  kind: z
    .string()
    .refine((kind) => kind !== 'text', 'not the text arm')
    .transform(() => 'binary' as const),
  originalContent: salvagedOptional('originalContent', z.string()),
  modifiedContent: salvagedOptional('modifiedContent', z.string()),
  isImage: salvagedOptional('isImage', z.boolean()),
  modifiedDeleted: salvagedOptional('modifiedDeleted', z.boolean()),
  mimeType: z.string().optional()
})

export type MobileFileTabDiff =
  | z.output<typeof fileTabTextDiffSchema>
  | z.output<typeof fileTabBinaryDiffSchema>

export { fileTabBinaryDiffSchema, fileTabTextDiffSchema }
