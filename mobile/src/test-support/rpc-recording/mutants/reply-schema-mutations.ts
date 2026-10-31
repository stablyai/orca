import type { OperationMutation } from '../operation-module-loader'

// Schema loosenings need malformed matrix variants, unit pins or consumer pins; valid pilot replies cannot detect them.
// Keep mutations off the recording path, as enforced by mutant-seam.test.ts.
// Required-member tests must omit one member at a time; ownership tests must distinguish absent, null and named hosts.
export const REPLY_SCHEMA_MUTATIONS = {
  // Killed by file-tab-doc-reply-schema unit tests; matrix omissions also omit siblings, masking this missing-content requirement.
  'file-tab-text-content-optional': {
    file: 'file-tab-doc-reply-schema.ts',
    before: '  content: z.string(),',
    after: '  content: z.string().optional(),'
  },
  // Killed by the explorer result-absent matrix error row and the unchecked-reader inventory boundary.
  'file-directory-read-unchecked': {
    file: 'mobile-file-explorer-operations.ts',
    before: "    read: rpcResultVariant('directory-entries', fileDirectoryEntriesSchema)",
    after: "    read: rpcUncheckedPayloadReader('directory-entries')"
  },
  // Collapse null hostId to absence to permit an unsafe local write; mobile-file-mutation-ownership tests pin refusal.
  'ownership-host-id-null-collapse': {
    file: 'mobile-file-mutation-ownership.ts',
    before: '  return buildMobileFileMutationOwnership(summary.hostId, sshState)',
    after: '  return buildMobileFileMutationOwnership(summary.hostId ?? undefined, sshState)'
  },
  // A closed source enum drops future image icons although no consumer reads source; host-screen-reply-schema unit tests pin openness.
  'repo-icon-source-closed': {
    file: 'host-screen-reply-schema.ts',
    before: '              src: z.string(),',
    after:
      "              src: z.string(),\n              source: z.enum(['upload', 'file', 'favicon', 'github']),"
  }
} as const satisfies Record<string, Omit<OperationMutation, 'name'>>

export type ReplySchemaMutation = keyof typeof REPLY_SCHEMA_MUTATIONS
