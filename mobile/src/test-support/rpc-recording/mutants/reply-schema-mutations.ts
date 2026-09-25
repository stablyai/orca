import type { OperationMutation } from '../operation-module-loader'

/**
 * Mutant evidence for the checked reply readers, in the same shape as the adapter-family mutations
 * beside it and kept apart from them for one reason: a reader mutation is not killed by a pilot
 * scenario's visible state. A pilot serves a *good* reply, and a schema that has stopped checking a
 * member still reads a good reply exactly as before. What kills these is the malformed partition of
 * a matrix golden, the schema's own unit pin, or a consumer pin — so they are applied by hand and
 * the gate that caught each is named below rather than being driven by `pilot-mutants.test.ts`.
 *
 * Nothing on the recording path imports this file, which `mutant-seam.test.ts` holds.
 *
 * Two of the first three survived their first run, and both survivals were defects in the gates
 * rather than in the readers:
 *
 *  - `file-tab-text-content-optional` survived because the unit pin dropped one required member at
 *    a time only in prose: it asserted `{ content, truncated }` and `{ content, byteLength }` were
 *    refused, and each of those is refused by the *other* missing member. The matrix golden masked
 *    it the same way, because `result-absent` fails on all three at once. The pin now drops exactly
 *    one member per iteration, and the same pattern was applied to the preview text schema and the
 *    legacy file list.
 *  - `ownership-host-id-null-collapse` survived because no golden serves an explicit `null` hostId:
 *    `files-ownership-local` omits the member instead. A tri-state is a consumer property rather
 *    than a projection one, so the gate added for it is a consumer pin that captures all three
 *    states end to end.
 */
export const REPLY_SCHEMA_MUTATIONS = {
  /**
   * (a) Loosens a member the file tab publishes into its ready document with no guard.
   *
   * Killed by `src/files/file-tab-doc-reply-schema.test.ts` — "requires the three members the tab
   * publishes into a ready document" and "requires the image content buildImageDataUri calls
   * replace on", because the anchor appears on both schemas in that file. Not killed by any
   * golden: every matrix partition that omits `content` omits its two siblings as well.
   */
  'file-tab-text-content-optional': {
    file: 'file-tab-doc-reply-schema.ts',
    before: '  content: z.string(),',
    after: '  content: z.string().optional(),'
  },
  /**
   * (b) Puts the directory listing back on the unchecked reader it replaced.
   *
   * Killed twice. `matrix-files.explorer-screen-files.readdir-1` diverges at
   * `files-explorer-legacy-fallback.result-absent:legacy-listed`, field
   * `state.elements.Pressable`: the Files tab draws the empty tree and no retry again instead of
   * the named error row. `unchecked-rpc-reader-boundary.test.ts` fails in the other direction —
   * "has no unlisted file holding an unchecked reader" — because the inventory line for this file
   * is gone.
   */
  'file-directory-read-unchecked': {
    file: 'mobile-file-explorer-operations.ts',
    before: "    read: rpcResultVariant('directory-entries', fileDirectoryEntriesSchema)",
    after: "    read: rpcUncheckedPayloadReader('directory-entries')"
  },
  /**
   * (c) Collapses the hostId tri-state, which is the one member on this branch where absence and an
   * explicit null mean different things: absent is "no host recorded" and captures local, null is a
   * host this client cannot place and refuses. The collapse sends a file write to the runtime-local
   * host for a workspace whose owner the reply did not establish.
   *
   * Killed by `src/files/mobile-file-mutation-ownership.test.ts` — "refuses a workspace whose reply
   * names an explicit null host" resolves to a local capture instead of rejecting.
   */
  'ownership-host-id-null-collapse': {
    file: 'mobile-file-mutation-ownership.ts',
    before: '  return buildMobileFileMutationOwnership(summary.hostId, sshState)',
    after: '  return buildMobileFileMutationOwnership(summary.hostId ?? undefined, sshState)'
  },
  /**
   * (d) Puts the closed image-source enum back on the repo icon — the one arm set on this branch
   * that was narrower than what the wire can carry. No mobile consumer reads `source`, so the
   * enum's only effect is that an icon whose source a later host adds fails the union arm, drops
   * whole, and draws the Folder default where main drew the image.
   *
   * Killed by `src/host-screen/host-screen-reply-schema.test.ts` — "keeps an image icon whose
   * source this build has never heard of". No golden kills it, and that is the point: this is the
   * member `settings-repo-metadata-icons` was recorded for, and a fixture can only carry a source
   * that exists today, so the future-arm case stays a unit property.
   */
  'repo-icon-source-closed': {
    file: 'host-screen-reply-schema.ts',
    before: '              src: z.string(),',
    after:
      "              src: z.string(),\n              source: z.enum(['upload', 'file', 'favicon', 'github']),"
  }
} as const satisfies Record<string, Omit<OperationMutation, 'name'>>

export type ReplySchemaMutation = keyof typeof REPLY_SCHEMA_MUTATIONS
