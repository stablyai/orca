// src/main/ssh/fleet-config-parser.ts
// Parser for orca-fleet.yaml — fleet inventory config file
import { z } from 'zod'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import * as fs from 'node:fs/promises'
import type { SshTarget } from './ssh-types'

// ── Zod Schemas ────────────────────────────────────────────────

const FleetRepoSchema = z.object({
  path: z.string(),
  name: z.string(),
  url: z.string().optional(),
  branch: z.string().optional()
})

const FleetPortForwardSchema = z.object({
  remotePort: z.number(),
  localPort: z.number(),
  label: z.string().optional()
})

const FleetServerBootstrapSchema = z.object({
  repos: z
    .array(
      z.object({
        url: z.string(),
        path: z.string(),
        branch: z.string().optional()
      })
    )
    .optional(),
  setupScript: z.string().optional()
})

const FleetServerSchema = z.object({
  id: z.string(),
  label: z.string(),
  host: z.string(),
  port: z.number().optional().default(22),
  username: z.string().optional(),
  identityFile: z.string().optional(), // @deprecated cho path backend-go (Vault-only invariant) — vẫn dùng cho path desktop/ legacy
  jumpHost: z.string().optional(),
  proxyCommand: z.string().optional(),
  relayGracePeriodSeconds: z.number().optional(),
  project: z.string().optional(),
  team: z.string().optional(),
  environment: z.enum(['development', 'staging', 'production']).optional(),
  tags: z.array(z.string()).optional(),
  repos: z.array(FleetRepoSchema).optional(),
  portForwards: z.array(FleetPortForwardSchema).optional(),
  bootstrap: FleetServerBootstrapSchema.optional(),
  // MỚI — bắt buộc khi target backend là backend-go's BulkProvisionFleet
  // (CR-FLEET-001). identityFile ở trên chỉ hợp lệ cho path desktop/
  // legacy — backend-go's domain.NewSshTarget không có field identityFile,
  // enforce Vault-only invariant (xem ssh_target.go's ErrEmptyVaultSSHRole).
  vaultSshRole: z.string().optional()
})

const FleetAccessPolicySchema = z.object({
  team: z.string().optional(),
  role: z.string().optional(),
  users: z.array(z.string()).optional(),
  allowedServers: z.union([z.literal('*'), z.array(z.string())]),
  agentTrust: z.enum(['minimal', 'standard', 'full']).optional(),
  canCreateWorktrees: z.boolean().optional(),
  canDeleteWorktrees: z.boolean().optional(),
  canAccessProduction: z.boolean().optional()
})

const FleetConfigSchema = z.object({
  version: z.literal('1'),
  defaults: FleetServerSchema.partial().optional(),
  bootstrap: z
    .object({
      nodeVersion: z.string().optional(),
      gitVersion: z.string().optional(),
      packages: z.array(z.string()).optional()
    })
    .optional(),
  access: z
    .object({
      sso: z
        .object({
          provider: z.enum(['github', 'google', 'keycloak', 'none']),
          clientId: z.string(),
          discoveryUrl: z.string().optional(),
          allowedOrg: z.string().optional(),
          allowedDomain: z.string().optional(),
          redirectUri: z.string().optional()
        })
        .optional(),
      policies: z.array(FleetAccessPolicySchema).optional()
    })
    .optional(),
  servers: z.array(FleetServerSchema)
})

// ── Exported Types ─────────────────────────────────────────────

export type FleetConfig = z.infer<typeof FleetConfigSchema>
export type FleetServer = z.infer<typeof FleetServerSchema>
export type FleetAccessPolicy = z.infer<typeof FleetAccessPolicySchema>

// ── Parser ─────────────────────────────────────────────────────

/**
 * Parse an orca-fleet.yaml file and validate against the schema.
 * @throws ZodError if validation fails
 * @throws Error if file not found or YAML is malformed
 */
export async function parseFleetConfig(filePath: string): Promise<FleetConfig> {
  const content = await fs.readFile(filePath, 'utf-8')
  return parseFleetConfigFromString(content)
}

/**
 * Parse fleet config from a YAML string (useful for testing).
 */
export function parseFleetConfigFromString(yamlContent: string): FleetConfig {
  const raw = parseYaml(yamlContent)
  return FleetConfigSchema.parse(raw)
}

/**
 * Convert a FleetServer entry to an SshTarget for storage.
 * Merges fleet-level defaults with server-specific values.
 */
export function fleetServerToSshTarget(
  server: FleetServer,
  defaults: Partial<FleetServer> | undefined,
  fleetConfigPath: string
): Omit<SshTarget, 'id'> {
  const merged = { ...defaults, ...server }
  return {
    label: merged.label,
    host: merged.host,
    port: merged.port ?? 22,
    username: merged.username ?? 'dev',
    identityFile: merged.identityFile,
    identityAgent: undefined,
    identitiesOnly: undefined,
    proxyCommand: merged.proxyCommand,
    jumpHost: merged.jumpHost,
    source: 'manual' as const,
    relayGracePeriodSeconds: merged.relayGracePeriodSeconds ?? 86400,
    // Fleet metadata
    project: merged.project,
    team: merged.team,
    environment: merged.environment,
    tags: merged.tags,
    repos: merged.repos?.map((r) => ({
      path: r.path,
      name: r.name,
      url: r.url,
      branch: r.branch
    })),
    fleetId: server.id,
    fleetConfigSource: fleetConfigPath
  }
}

/**
 * Serialize a list of SshTargets back to FleetConfig YAML string.
 */
export function sshTargetsToFleetConfigYaml(targets: SshTarget[]): string {
  const config: FleetConfig = {
    version: '1',
    servers: targets
      .filter((t) => t.fleetId !== undefined || t.project !== undefined)
      .map((t) => ({
        id: t.fleetId ?? t.id,
        label: t.label,
        host: t.host,
        port: t.port,
        username: t.username,
        identityFile: t.identityFile,
        jumpHost: t.jumpHost,
        proxyCommand: t.proxyCommand,
        relayGracePeriodSeconds: t.relayGracePeriodSeconds,
        project: t.project,
        team: t.team,
        environment: t.environment,
        tags: t.tags,
        repos: t.repos
      }))
  }
  return stringifyYaml(config)
}

/**
 * Serialize a list of SshTargets back to FleetConfig object.
 */
export function sshTargetsToFleetConfig(targets: SshTarget[]): FleetConfig {
  return {
    version: '1',
    servers: targets
      .filter((t) => t.fleetId !== undefined || t.project !== undefined)
      .map((t) => ({
        id: t.fleetId ?? t.id,
        label: t.label,
        host: t.host,
        port: t.port,
        username: t.username,
        identityFile: t.identityFile,
        jumpHost: t.jumpHost,
        proxyCommand: t.proxyCommand,
        relayGracePeriodSeconds: t.relayGracePeriodSeconds,
        project: t.project,
        team: t.team,
        environment: t.environment,
        tags: t.tags,
        repos: t.repos
      }))
  }
}
