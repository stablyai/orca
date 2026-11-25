import { z } from 'zod'
import type { ConnectorTransport } from './connector-machine'
import { postConnectorAction } from './connector-actions'
import { isConnectorWorkspaceRef } from '../../shared/connector-action-contract'
import { isRefOf } from '../../shared/connector-place-names'

/** place: a channel, repo or Linear team; subject: a thread, issue or pull request. */
export type ConnectorRefRole = 'place' | 'subject'
/** key: the id or key an older peer names it by (C0123ABCD, ENG-42), when the cloud says. */
export type ResolvedConnectorRef = { ref: string; label: string; key?: string }

/** A ref for what a person or bot wrote; throws, in words, when the cloud can't name one place. */
export type ConnectorRefResolver = (
  botId: string,
  source: string,
  role: ConnectorRefRole,
  input: string
) => Promise<ResolvedConnectorRef>

/** The cloud answered and the bot reaches nothing by that name: saved anyway, it would never match. */
export class ConnectorRefNotFoundError extends Error {}

// The owner/name a GitHub repo, issue or pull request's name or link starts with.
const GITHUB_REPO =
  /^(?:https?:\/\/(?:www\.)?github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[#/?]|$)/i

function notFound(source: string, input: string): ConnectorRefNotFoundError {
  const repo = source === 'github' ? GITHUB_REPO.exec(input.trim())?.[1] : undefined
  return new ConnectorRefNotFoundError(
    repo
      ? `${repo} isn't among the repositories the Orca GitHub app can reach; add it with \`orca bot connectors --offer github\`.`
      : `Nothing the bot reaches in ${source} matches "${input}". Pass a link, an id or a ref.`
  )
}

const Matches = z.object({
  matches: z.array(
    z.object({
      ref: z.string(),
      label: z.string(),
      exact: z.literal(true).optional(),
      key: z.string().optional()
    })
  )
})

/**
 * Through the cloud's find, which alone reads links, #names and keys; only one exact match is taken.
 * takesWorkspaces: the cloud matches a whole workspace as a place; an older one would save it and
 * never match it.
 */
export function connectorRefResolver(
  transport: ConnectorTransport,
  signal: AbortSignal,
  takesWorkspaces: boolean
): ConnectorRefResolver {
  return async (botId, source, role, input) => {
    if (!takesWorkspaces && isConnectorWorkspaceRef(input)) {
      throw new Error(
        `This computer's Orca Cloud can't listen in a whole workspace yet; name a channel, repo or team instead of "${input}".`
      )
    }
    const answer = await postConnectorAction(
      transport,
      { botId, verb: 'find', ref: input, args: { of: role } },
      signal
    )
    if (!answer.ok) {
      throw new Error(
        `Orca Cloud couldn't look up "${input}" (${answer.error ?? 'no answer'}). Try again in a moment.`
      )
    }
    if (!answer.value.ok) {
      throw new Error(answer.value.message)
    }
    const found = (Matches.safeParse(answer.value.result).data?.matches ?? []).filter((match) =>
      match.ref.startsWith(`${source}:`)
    )
    const exact = found.filter((match) => match.exact)
    const [only] = exact
    if (only && exact.length === 1) {
      // A ref as input comes back labelled with itself; the place's own find names it.
      const label = isRefOf(source, only.label)
        ? await refLabel(transport, signal, botId, source, only.ref)
        : only.label
      return { ref: only.ref, label, ...(only.key ? { key: only.key } : {}) }
    }
    if (found.length === 0) {
      throw notFound(source, input)
    }
    const listed = found.map((match) => `${match.ref}  ${match.label}`)
    throw new Error(
      [`"${input}" names no one place exactly; pass one of these refs:`, ...listed].join('\n')
    )
  }
}

// The name a ref's own find gives it ("#orca", "owner/name#12"); the ref itself when it can't say.
async function refLabel(
  transport: ConnectorTransport,
  signal: AbortSignal,
  botId: string,
  source: string,
  ref: string
): Promise<string> {
  const answer = await postConnectorAction(
    transport,
    { botId, verb: 'find', ref, args: {} },
    signal
  ).catch(() => null)
  const matches = answer?.ok && answer.value.ok ? Matches.safeParse(answer.value.result).data : null
  const label = matches?.matches[0]?.label
  return label && !isRefOf(source, label) ? label : ref
}
