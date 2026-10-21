import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// What the preview screen reads for one file, and what the grant refresh reads to re-mint a stale
// grant. Checked against the four handlers in src/main/runtime/rpc/methods/files.ts:70/104 and
// files-terminal-artifact-methods.ts:10/21/42, and the shared results they return verbatim:
// RuntimeFileReadResult, RuntimeFilePreviewResult and RuntimeTerminalPathResolution in
// src/shared/runtime-file-contracts.ts.
//
// Three encodings are used here and mean three different things, so they are stated once:
//   - a required member is one a consumer reads with no guard, where absence renders `undefined`
//     or throws on the next property;
//   - `salvagedOptional(name, T)` is for a member behind a *typed* guard with a fallback — the
//     salvage lands on exactly that fallback, so the screen shows what main showed;
//   - `z.unknown()` is for a member read only for truthiness, because narrowing it would move
//     main's answer for a value the consumer's own guard already accepted.

/**
 * A file's text, for `files.read` and `files.readTerminalArtifact` alike: one host result type, and
 * the preview screen normalizes both through the same projection.
 *
 * `content` is required because the markdown disk fallback reads it with no guard —
 * use-mobile-session-document-readers.ts:60 publishes it straight into the tab's ready document, so
 * a reply without one rendered `undefined` in the editor. The preview screen's own reader guards it
 * (`typeof preview.content !== 'string'` in mobile-file-preview-response.ts:142) and lands on
 * 'Unable to load preview', which is the same copy `previewError` gives the incompatible-reply
 * message — so requiring it moves the preview screen's text not at all.
 *
 * `truncated` and `byteLength` stay salvaged. Both are declared required by RuntimeFileReadResult,
 * but neither can crash or render garbage: `truncated` is a truthiness test behind a read-only
 * reason string and `byteLength` has main's own `preview.content.length` fallback behind a
 * `typeof === 'number'` guard. Requiring either would only let a host that trims a field take the
 * whole preview down. `isBinary` is never sent on these two methods — the host raises `binary_file`
 * instead — but the projection still checks it, so it is declared where main looked for it.
 */
export const filePreviewTextSchema = z.looseObject({
  content: z.string(),
  truncated: salvagedOptional('truncated', z.boolean()),
  byteLength: salvagedOptional('byteLength', z.number()),
  isBinary: salvagedOptional('isBinary', z.boolean())
})

/**
 * A file's image bytes, for `files.readPreview` and `files.readTerminalArtifactPreview`.
 *
 * Nothing is required: normalizeImagePreviewResult guards all four members and falls back to
 * `previewError('binary_file')` for every one of them, and that fallback is load-bearing — the host
 * answers `{ content, isBinary: true }` with no mime for a binary it cannot preview, and
 * `{ content, isBinary: false }` for a path mobile classifies as an image and the host does not.
 * Both are good replies the screen renders today. The guards are all `=== true` / `!== true` /
 * `typeof === 'string'`, so a salvaged member lands on exactly the arm main took.
 *
 * What the schema adds is the container. A bare string or a null result reached the projection as
 * 'Binary preview unavailable', which names the file rather than the reply.
 */
export const filePreviewImageSchema = z.looseObject({
  content: salvagedOptional('content', z.string()),
  isBinary: salvagedOptional('isBinary', z.boolean()),
  isImage: salvagedOptional('isImage', z.boolean()),
  mimeType: salvagedOptional('mimeType', z.string())
})

/**
 * A terminal path re-resolved to mint a fresh grant.
 *
 * Nothing is required and every member is salvaged: isTerminalArtifactResolution
 * (mobile-terminal-artifact-grant-refresh.ts:77) is a total guard that answers "not refreshable"
 * for anything it cannot read, and a refusal to refresh is a normal outcome rather than an error.
 * The schema declares the members that guard reads so a newer host's extra keys pass through, and
 * adds only the container.
 */
export const terminalPathResolutionSchema = z.looseObject({
  exists: salvagedOptional('exists', z.boolean()),
  isDirectory: salvagedOptional('isDirectory', z.boolean()),
  openTarget: salvagedOptional(
    'openTarget',
    z.looseObject({
      kind: salvagedOptional('kind', z.string()),
      absolutePath: salvagedOptional('absolutePath', z.string()),
      grantId: salvagedOptional('grantId', z.string()),
      readOnly: salvagedOptional('readOnly', z.literal(true))
    })
  )
})

/**
 * The artifact save's reply body, which no call site reads.
 *
 * `writeTerminalArtifactFile` answers `{ ok: true }` and settlePreviewSend looks only at the
 * acceptance verdict, so declaring a member would be a requirement with no reader behind it.
 */
export const terminalArtifactWriteSchema = z.unknown()
