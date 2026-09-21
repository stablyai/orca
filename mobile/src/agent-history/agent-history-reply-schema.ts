import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// The agent-history screen's own reads and the workspace metadata its resume sheet loads.
// Checked against src/main/runtime/rpc/methods/status.ts:6, ai-vault.ts:66, repo.ts:29/42,
// folder-workspace.ts:12 and worktree-catalog-methods.ts:12, and the shared records they return:
// AiVaultSession and AiVaultScanIssue in src/shared/ai-vault-types.ts.

/**
 * The capability list the screen gates the whole surface on.
 *
 * `capabilities` sits behind main's own `?.includes` and stays salvaged: a reply without a readable
 * list reads as "this host does not advertise the vault", which is the `unsupported` screen main
 * already showed for it. Individual entries are not narrowed — the list is a growing vocabulary and
 * every read is an `includes` against one known token.
 *
 * The status payload itself is otherwise passed through: the panel hands the whole record to
 * readMobileRuntimeHostPlatform and readMobileRuntimeTerminalWindowsShell, both total guards over
 * `unknown`, so re-declaring what they read here would narrow two members this screen never
 * destructures.
 */
export const agentHistoryHostStatusSchema = z.looseObject({
  capabilities: salvagedOptional('capabilities', z.array(z.string()))
})

/**
 * The session scan.
 *
 * Both members are required arrays: use-mobile-agent-history-state.ts:133-135 publishes them straight
 * into the ready screen state, where the list maps `sessions` and the issue banner counts `issues`
 * — a reply missing either left the screen `ready` over an undefined container and crashed on the
 * next render, which is the defect this reader exists to name.
 *
 * The rows stay unknown, and that is deliberate rather than unfinished. A row is an AiVaultSession,
 * whose `agent` is a 21-arm vocabulary that grows with every agent CLI Orca learns to scan — and
 * which this client echoes straight back to the host when it resumes a session. Declaring it would
 * either refuse a newer host's whole reply or silently drop the very sessions that host added, and
 * the remote-wire contract is explicit that a member a client sends back passes through as the host
 * wrote it rather than through a client-side fallback.
 */
export const agentHistorySessionScanSchema = z.looseObject({
  sessions: z.array(z.unknown()),
  issues: z.array(z.unknown())
})

/**
 * The repo identities the resume sheet resolves a session's workspace through.
 *
 * `repos` is required and an array: loadMobileResumeMetadata reads the member off the payload and
 * only then falls back to `[]`, so a null result was a property read on null at the return
 * statement and a non-array reached every `repos.find` as one. The rows stay unknown for the same
 * reason the session rows do — `executionHostId` is a host-id spelling the resolver already
 * degrades, and closing it here would refuse a newer host's own catalog.
 */
export const resumeRepoListSchema = z.looseObject({ repos: z.array(z.unknown()) })

/**
 * The folder workspaces, project groups and worktrees the resume sheet enriches a target with.
 *
 * All three are skips whose member read stays at the call site behind `readAcceptedResumeList`,
 * which answers `undefined` for anything it cannot read and lets each list degrade to empty. Only
 * the container is checked here, because that is the one thing main did not check: a bare string
 * reply reached `?.[key]` as `undefined` and the sheet resolved every target to `unknown` with no
 * sign anything had gone wrong.
 */
export const resumeMetadataListSchema = z.looseObject({})
