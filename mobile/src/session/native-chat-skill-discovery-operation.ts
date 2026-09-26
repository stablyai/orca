import { z } from 'zod'
import type { DiscoveredSkill, SkillDiscoverySource } from '../../../src/shared/skills'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'

// The slash menu's read of skills.discover: which installed skills the lane's agent can be
// offered. Checked against src/shared/skills.ts; annotated like the shared schemas so the
// rows feed isNativeChatSkillForAgent/discoveredSkillTokenName without a cast.

// `owner` stays a plain string because AgentType is open (WellKnownAgentType | string & {});
// `plugin`, `rootPaths` and `skippedReason` are optional so an older host's rows still parse.
const discoveredSkillRowSchema: z.ZodType<DiscoveredSkill> = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  providers: z.array(z.enum(['codex', 'claude', 'agent-skills'])),
  sourceKind: z.enum(['home', 'repo', 'bundled', 'plugin']),
  sourceLabel: z.string(),
  plugin: z.string().optional(),
  rootPath: z.string(),
  rootPaths: z.array(z.string()).optional(),
  directoryPath: z.string(),
  skillFilePath: z.string(),
  installed: z.boolean(),
  updatedAt: z.number().nullable()
})

const skillSourceRowSchema: z.ZodType<SkillDiscoverySource> = z.looseObject({
  id: z.string(),
  label: z.string(),
  path: z.string(),
  sourceKind: z.enum(['home', 'repo', 'bundled', 'plugin']),
  providers: z.array(z.enum(['codex', 'claude', 'agent-skills'])),
  owner: z.string().nullable(),
  plugin: z.string().optional(),
  exists: z.boolean(),
  skippedReason: z.enum(['missing', 'remote-repo', 'unavailable']).optional()
})

/**
 * skills.discover for a worktree. Any refusal — including a host that predates the
 * mobile-allowed method — throws, and the hook's catch leaves the curated catalog and any
 * session-reported skills standing, which is the feature's contract.
 */
export const nativeChatSkillDiscoveryRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'skills.discover-slash-menu',
    method: 'skills.discover',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'discovered-skills',
      z.looseObject({
        skills: z.array(discoveredSkillRowSchema),
        sources: z.array(skillSourceRowSchema)
      })
    )
  })
)
