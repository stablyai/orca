import { z } from 'zod'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const text = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => !/[\0\r\n]/.test(s))
export const TeamRole = z
  .object({
    id: text,
    title: text,
    provider: z.enum(['codex', 'claude']),
    model: text,
    effort: z.enum(['low', 'medium', 'high', 'xhigh']),
    cwd: text.default('.'),
    instructions: z.array(text).min(1).max(40),
    account: text.optional(),
    configHome: text.optional(),
    codexSettings: z
      .object({
        model_auto_compact_token_limit: z.number().int().positive().max(16_000_000),
        model_auto_compact_token_limit_scope: z.literal('total')
      })
      .strict()
      .optional(),
    tools: z.enum(['Read,Glob,Grep', 'Read,Glob,Grep,Write,Edit,Bash']).optional(),
    settingsFile: text.optional(),
    pluginDir: text.optional(),
    scopeDirs: z.array(text).max(100).default([]),
    permissionMode: z.enum(['manual', 'auto']).default('manual')
  })
  .strict()
export const ProjectTeam = z
  .object({
    version: z.literal(1),
    name: text,
    roles: z.array(TeamRole).min(1).max(32)
  })
  .strict()
  .refine((t) => new Set(t.roles.map((r) => r.id)).size === t.roles.length, 'Duplicate role id')
  .refine(
    (t) => new Set(t.roles.map((r) => r.title)).size === t.roles.length,
    'Duplicate role title'
  )
export const TeamRegistry = z
  .object({
    version: z.literal(1),
    teams: z
      .array(
        z
          .object({
            config: text,
            projectRoot: text,
            enabled: z.boolean().default(true)
          })
          .strict()
      )
      .max(32)
  })
  .strict()
export type ProjectTeamConfig = z.infer<typeof ProjectTeam>
export type ProjectTeamRole = z.infer<typeof TeamRole>
export type ProjectTeamBinding = z.infer<typeof TeamRegistry>['teams'][number]

export async function readTeamJson(file: string): Promise<unknown> {
  const raw = await readFile(file, 'utf8')
  if (Buffer.byteLength(raw) > 1024 * 1024) {
    throw new Error('team_config_too_large')
  }
  return JSON.parse(raw)
}
export function resolveTeamPath(value: string, root: string): string {
  return value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : resolve(root, value)
}
export async function readTeamResource(configFile: string, resource: string): Promise<string> {
  return (await loadTeamResource(configFile, resource)).text
}
export async function loadTeamResource(
  configFile: string,
  resource: string
): Promise<{ path: string; text: string }> {
  const base = await realpath(dirname(configFile))
  const file = await realpath(resolve(base, resource))
  const part = relative(base, file)
  if (isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)) {
    throw new Error('team_resource_outside_config')
  }
  const raw = await readFile(file, 'utf8')
  if (Buffer.byteLength(raw) > 1024 * 1024) {
    throw new Error('team_resource_too_large')
  }
  return { path: file, text: raw }
}
