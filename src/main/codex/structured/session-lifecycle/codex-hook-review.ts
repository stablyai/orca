import { z } from 'zod'
import type {
  AgentSessionHooks,
  AgentSessionHookTrust
} from '../../../../shared/agent-session/agent-session-hooks'
import type { CodexAppServerRpc } from '../../app-server/codex-app-server-session'

const Hook = z.object({
  key: z.string().min(1),
  currentHash: z.string().min(1),
  handlerType: z.string(),
  command: z.string().optional(),
  eventName: z.string(),
  matcher: z.string().nullable().optional(),
  source: z.string(),
  sourcePath: z.string(),
  enabled: z.boolean(),
  isManaged: z.boolean(),
  trustStatus: z.enum(['managed', 'untrusted', 'trusted', 'modified']),
  timeoutSec: z.number(),
  async: z.boolean().optional()
})
const Listing = z.object({
  data: z
    .array(
      z.object({
        cwd: z.string(),
        hooks: z.array(Hook),
        errors: z.array(z.object({ message: z.string(), path: z.string() })),
        warnings: z.array(z.string())
      })
    )
    .length(1)
})

export async function reviewCodexHooks(
  request: CodexAppServerRpc['request'],
  params: { threadId: string } | { cwds: string[] },
  scope: string,
  live: boolean,
  trust?: AgentSessionHookTrust,
  assertCurrent: () => void = () => {}
): Promise<AgentSessionHooks> {
  const read = async (): Promise<AgentSessionHooks> => {
    const {
      data: [entry]
    } = Listing.parse(await request('hooks/list', params, { timeoutMs: 10_000 }))
    if (entry.errors.length) {
      throw new Error(entry.errors.map(({ path, message }) => `${path}: ${message}`).join('\n'))
    }
    return { scope, cwd: entry.cwd, live, hooks: entry.hooks, warnings: entry.warnings }
  }
  const listing = await read()
  if (!trust) {
    return listing
  }
  const matches = listing.hooks.filter((hook) => hook.key === trust.key)
  const hook = matches[0]
  if (
    trust.scope !== scope ||
    matches.length !== 1 ||
    !hook ||
    hook.currentHash !== trust.currentHash ||
    hook.isManaged ||
    hook.trustStatus === 'managed' ||
    hook.handlerType !== 'command' ||
    !hook.command
  ) {
    throw new Error('The hook or chat changed. Refresh and review it again before trusting it.')
  }
  assertCurrent()
  if (hook.trustStatus === 'trusted') {
    return listing
  }
  await request(
    'config/batchWrite',
    {
      edits: [
        {
          keyPath: 'hooks.state',
          value: { [hook.key]: { trusted_hash: trust.currentHash } },
          mergeStrategy: 'upsert'
        }
      ],
      reloadUserConfig: true
    },
    { timeoutMs: 10_000 }
  )
  const updated = await read()
  if (
    !updated.hooks.some(
      (row) =>
        row.key === hook.key &&
        row.currentHash === trust.currentHash &&
        row.trustStatus === 'trusted'
    )
  ) {
    throw new Error(
      'Codex did not confirm this hook as trusted. Refresh and review its current state.'
    )
  }
  return updated
}
