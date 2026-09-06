import type { ResolveProjectRefArgs } from '../../../shared/github/project-request-types'
import type {
  GitHubProjectViewError,
  ResolveProjectRefResult
} from '../../../shared/github/project-result-types'
import type { GitHubProjectOwnerType } from '../../../shared/github/project-types'
import {
  GITHUB_PROJECT_REF_INPUT_TOO_LARGE_ERROR,
  isGitHubProjectRefInputTooLarge
} from '../../../shared/github/project-ref-input'
import { githubProjectHost } from '../../../shared/github/project-identity'
import { isValidOwnerSlug, projectGhExecOptions, runGraphql, type GraphqlVars } from './internals'
import { getCachedOwnerType, rememberOwnerType } from './project-view-cache'
import { ownerQueryRoot } from './project-view-config'

// ─── resolveProjectRef ─────────────────────────────────────────────────

type ParsedPaste =
  | { kind: 'org'; owner: string; number: number; host: string; viewNumber?: number }
  | { kind: 'user'; owner: string; number: number; host: string; viewNumber?: number }
  | { kind: 'bare'; owner: string; number: number }

export function parseProjectPaste(input: string, host?: string): ParsedPaste | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  if (isGitHubProjectRefInputTooLarge(trimmed)) {
    return null
  }
  // Why: URL parsing enforces an exact Project path and rejects credentials;
  // a prefix regex could silently turn `/projects/1evil` into Project 1.
  try {
    const url = new URL(trimmed)
    const allowedHosts = new Set(['github.com', ...(host ? [host.trim().toLowerCase()] : [])])
    const parts = url.pathname.split('/').filter(Boolean)
    const hasView = parts.length === 6 && parts[4] === 'views'
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username ||
      url.password ||
      !allowedHosts.has(url.host.toLowerCase()) ||
      (parts[0] !== 'orgs' && parts[0] !== 'users') ||
      !isValidOwnerSlug(parts[1]) ||
      parts[2] !== 'projects' ||
      (parts.length !== 4 && !hasView)
    ) {
      return null
    }
    const number = Number(parts[3])
    const viewNumber = hasView ? Number(parts[5]) : undefined
    if (
      !Number.isSafeInteger(number) ||
      number < 1 ||
      (hasView && (!Number.isSafeInteger(viewNumber) || (viewNumber ?? 0) < 1))
    ) {
      return null
    }
    return {
      kind: parts[0] === 'orgs' ? 'org' : 'user',
      owner: parts[1],
      number,
      host: url.host.toLowerCase(),
      ...(viewNumber !== undefined ? { viewNumber } : {})
    }
  } catch {
    // Shorthand parsing below remains available for non-URL input.
  }
  // owner/number shorthand — owner alphabet matches OWNER_SLUG_RE.
  const shortRe = /^([A-Za-z0-9][A-Za-z0-9-]*)\/(\d+)$/
  const sm = trimmed.match(shortRe)
  if (sm) {
    const number = Number.parseInt(sm[2], 10)
    if (!Number.isInteger(number) || number < 1) {
      return null
    }
    return { kind: 'bare', owner: sm[1], number }
  }
  return null
}

async function resolveOwnerType(
  owner: string,
  preferred: GitHubProjectOwnerType | null,
  host?: string
): Promise<
  | { ok: true; ownerType: GitHubProjectOwnerType; title: string }
  | { ok: false; error: GitHubProjectViewError }
> {
  const tryOne = async (
    ot: GitHubProjectOwnerType,
    num: number | null
  ): Promise<{ ok: true; title: string } | { ok: false; error: GitHubProjectViewError }> => {
    const root = ownerQueryRoot(ot)
    // If number is provided, fetch the project title; else just confirm owner exists.
    const query = num
      ? `
        query($owner:String!, $num:Int!) {
          ${root}(login:$owner) { projectV2(number:$num) { id title } }
        }
      `
      : `
        query($owner:String!) {
          ${root}(login:$owner) { login }
        }
      `
    const vars: GraphqlVars = { owner }
    if (num) {
      vars.num = num
    }
    const res = await runGraphql<
      Record<string, { projectV2?: { id?: string; title?: string } | null; login?: string } | null>
    >(query, vars, projectGhExecOptions(host))
    if (!res.ok) {
      return { ok: false, error: res.error }
    }
    const top = res.data[root]
    if (!top) {
      return { ok: false, error: { type: 'not_found', message: 'Owner not found.' } }
    }
    if (num) {
      const p = top.projectV2
      if (!p || typeof p.id !== 'string') {
        return { ok: false, error: { type: 'not_found', message: 'Project not found.' } }
      }
      return { ok: true, title: p.title ?? '' }
    }
    return { ok: true, title: '' }
  }

  const cached = getCachedOwnerType(owner, host)
  const candidates: GitHubProjectOwnerType[] = preferred
    ? [preferred]
    : cached
      ? [cached]
      : ['organization', 'user']
  const fallback: GitHubProjectOwnerType[] = preferred
    ? []
    : cached
      ? cached === 'organization'
        ? ['user']
        : ['organization']
      : []
  const ordered = [...candidates, ...fallback]
  let lastError: GitHubProjectViewError | null = null
  for (const ot of ordered) {
    const r = await tryOne(ot, null)
    if (r.ok) {
      rememberOwnerType(owner, ot, host)
      return { ok: true, ownerType: ot, title: r.title }
    }
    lastError = r.error
    if (r.error.type !== 'not_found') {
      // Non-NOT_FOUND errors (auth, network, rate) should not trigger fallback.
      return { ok: false, error: r.error }
    }
  }
  rememberOwnerType(owner, null, host)
  return {
    ok: false,
    error: lastError ?? { type: 'not_found', message: 'Owner not found.' }
  }
}

export async function resolveProjectRef(
  args: ResolveProjectRefArgs
): Promise<ResolveProjectRefResult> {
  const input = typeof args.input === 'string' ? args.input.trim() : ''
  if (!input) {
    return {
      ok: false,
      error: { type: 'validation_error', message: 'Input required.' }
    }
  }
  if (isGitHubProjectRefInputTooLarge(input)) {
    return {
      ok: false,
      error: { type: 'validation_error', message: GITHUB_PROJECT_REF_INPUT_TOO_LARGE_ERROR }
    }
  }
  const parsed = parseProjectPaste(input, args.host)
  if (!parsed) {
    return {
      ok: false,
      error: {
        type: 'validation_error',
        message: 'Could not parse input. Expected a GitHub project URL or `owner/number`.'
      }
    }
  }
  const preferred: GitHubProjectOwnerType | null =
    parsed.kind === 'org' ? 'organization' : parsed.kind === 'user' ? 'user' : null
  // Why: a pasted URL is authoritative. The ambient host only applies to
  // owner/number shorthand; otherwise same-number Projects can cross hosts.
  const executionHost = parsed.kind === 'bare' ? githubProjectHost(args.host) : parsed.host
  // Verify by fetching project title.
  const ownerRes = await resolveOwnerType(parsed.owner, preferred, executionHost)
  if (!ownerRes.ok) {
    return { ok: false, error: ownerRes.error }
  }
  const ownerType = ownerRes.ownerType
  const root = ownerQueryRoot(ownerType)
  const query = `
    query($owner:String!, $num:Int!) {
      ${root}(login:$owner) { projectV2(number:$num) { id title } }
    }
  `
  const res = await runGraphql<
    Record<string, { projectV2?: { id?: string; title?: string } | null } | null>
  >(query, { owner: parsed.owner, num: parsed.number }, projectGhExecOptions(executionHost))
  if (!res.ok) {
    return { ok: false, error: res.error }
  }
  const p = res.data[root]?.projectV2
  if (!p || typeof p.id !== 'string') {
    return { ok: false, error: { type: 'not_found', message: 'Project not found.' } }
  }
  return {
    ok: true,
    owner: parsed.owner,
    ownerType,
    number: parsed.number,
    title: p.title ?? '',
    host: executionHost,
    // Why: forward URL view numbers so the renderer can skip view selection; bare shorthand has none.
    ...(parsed.kind !== 'bare' && parsed.viewNumber !== undefined
      ? { viewNumber: parsed.viewNumber }
      : {})
  }
}
