import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// The two reads that pin which execution host owns a workspace before a file mutation is sent.
// Checked against src/main/runtime/rpc/methods/worktree.ts:48 and ssh.ts:30, and the shared
// SshConnectionState in src/shared/ssh-types.ts:187.
//
// This capture decides where a write lands, so the usual "degrade to absent" salvage is wrong for
// the two members it routes on: absent reads as *local* downstream, and turning an unreadable owner
// into a local one is how a mutation reaches the wrong host. Both are declared fatal instead.

/**
 * The workspace row a mutation targets.
 *
 * The payload wrapper stays nullish so an absent `worktree` still reaches
 * mobile-file-mutation-ownership.ts:68 as the `!summary` throw main had, rather than as a decode
 * failure — the host answers `{ worktree: undefined }` for a selector it cannot resolve.
 *
 * `hostId` is a plain nullable optional, not a salvaged one, and the distinction is load-bearing
 * twice over. Its three states are distinct to buildMobileFileMutationOwnership: absent means "no
 * host recorded" and yields a local capture, `null` means the reply named a host this client cannot
 * place and is refused (mobile-file-mutation-ownership.ts:32, pinned at its test:122), and a string
 * is parsed. A salvage would fold a *wrong-typed* hostId into absent and let the mutation go local;
 * main threw "Couldn't verify the SSH connection" on it, and an incompatible reply throws too.
 */
export const fileOwnershipWorktreeSchema = z
  .looseObject({
    worktree: z.looseObject({ hostId: z.string().nullable().optional() }).nullish()
  })
  .transform((reply) => reply.worktree)

/**
 * The SSH connection generation the mutation is expected to still be running on.
 *
 * `connectionGeneration` is echoed back to the host as `expectedSshConnectionGeneration` on the
 * mutation itself, so it is passed through at its own type and a wrong type is fatal: a reply-side
 * fallback here would put a value on the wire that the host then refuses, and main's
 * `=== undefined` check would have let a non-number through unnoticed.
 *
 * `targetId` is only ever compared against the parsed host's own target, so a salvaged member lands
 * on exactly main's mismatch throw. The `state` member itself is nullish because the host answers
 * `{ state: null }` for a target it holds no connection for, which is the normal local case.
 */
export const fileOwnershipSshStateSchema = z
  .looseObject({
    state: z
      .looseObject({
        targetId: salvagedOptional('targetId', z.string()),
        connectionGeneration: z.number().optional()
      })
      .nullish()
  })
  .transform((reply) => reply.state)
