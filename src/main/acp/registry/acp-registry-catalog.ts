// The official ACP Registry: which agents publish builds, and where each host's build lives.

import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { getMainHttpClient } from '../../network/http-client'
import { hourlyLookup } from '../../node-runtime/managed-runtime-latest-release'
import { isMuslHost } from '../../node-runtime/linux-libc-probe'

const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'

const binaryTargetSchema = lazyZodSchema(() =>
  z.object({
    archive: z.string().url(),
    cmd: z.string().min(1),
    sha256: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .transform((sha) => sha.toLowerCase())
      .optional()
  })
)

const registryAgentSchema = lazyZodSchema(() =>
  z.object({
    id: z.string().min(1),
    version: z.string().regex(/^\d[0-9A-Za-z.+-]*$/),
    distribution: z.object({ binary: z.record(z.string(), binaryTargetSchema).optional() })
  })
)

export type AcpRegistryAgent = z.infer<typeof registryAgentSchema>
export type AcpRegistryBinaryTarget = z.infer<typeof binaryTargetSchema>

// Each agent parses alone, so one malformed listing never hides the others.
const registrySchema = lazyZodSchema(() => z.object({ agents: z.array(z.unknown()) }))

async function fetchRegistry(signal?: AbortSignal): Promise<ReadonlyMap<string, AcpRegistryAgent>> {
  const response = await getMainHttpClient().fetch(REGISTRY_URL, { signal })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`ACP Registry lookup failed (${response.status})`)
  }
  const agents = registrySchema
    .parse(await response.json())
    .agents.flatMap((agent) => registryAgentSchema.safeParse(agent).data ?? [])
  return new Map(agents.map((agent) => [agent.id, agent]))
}

const registry = hourlyLookup(fetchRegistry)

/** `id`'s registry listing, looked up at most hourly; a failed lookup answers from the last known one. */
export async function acpRegistryAgent(
  id: string,
  signal?: AbortSignal
): Promise<AcpRegistryAgent | null> {
  await registry.refresh(signal).catch((error: unknown) => {
    if (!registry.latest()) {
      throw error
    }
    console.warn('[acp-registry] lookup failed; using the last known registry:', error)
  })
  return registry.latest()?.get(id) ?? null
}

/** The last known listing of `id` without a lookup; undefined before the registry was read. */
export function knownAcpRegistryAgent(id: string): AcpRegistryAgent | null | undefined {
  const known = registry.latest()
  return known === undefined ? undefined : (known.get(id) ?? null)
}

/** The registry's key for this host's build, e.g. `darwin-aarch64` or `linux-x86_64-musl`. */
export function acpRegistryTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl: boolean = isMuslHost()
): string | null {
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null
  const os =
    platform === 'darwin'
      ? 'darwin'
      : platform === 'linux'
        ? 'linux'
        : platform === 'win32'
          ? 'windows'
          : null
  return cpu && os ? `${os}-${cpu}${os === 'linux' && musl ? '-musl' : ''}` : null
}
