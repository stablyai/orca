import type { HandlerContext } from '../dispatch'

// Guides wrap feature-specific text in these blocks so agents only learn features the host has on.
export const GUIDE_HOST_CAPABILITIES = ['artifact-publishing', 'skill-publishing'] as const
export type GuideHostCapability = (typeof GUIDE_HOST_CAPABILITIES)[number]

const HOST_CAPABILITY_BLOCK =
  /<!-- host-capability: ([a-z-]+) -->\n+([\s\S]*?)\n+<!-- \/host-capability -->(\n*)/g

export function hasHostCapabilityBlocks(markdown: string): boolean {
  return markdown.includes('<!-- host-capability: ')
}

export function filterHostCapabilityBlocks(markdown: string, enabled: ReadonlySet<string>): string {
  return markdown.replace(HOST_CAPABILITY_BLOCK, (_block, name: string, body: string, tail) =>
    enabled.has(name) ? `${body}${tail}` : ''
  )
}

type SharingSettings = { artifactSharingEnabled?: boolean; agentSkillSharingEnabled?: boolean }

/** Mirrors the publish commands' targets; any unreadable state hides the blocks (fail closed). */
export async function readEnabledHostCapabilities(
  ctx: HandlerContext
): Promise<ReadonlySet<GuideHostCapability>> {
  const enabled = new Set<GuideHostCapability>()
  try {
    const response = await ctx.client.call<{ settings?: SharingSettings }>(
      'settings.get',
      undefined,
      { timeoutMs: 2_000 }
    )
    const settings = response.result?.settings
    if (settings?.artifactSharingEnabled === true) {
      enabled.add('artifact-publishing')
    }
    // `skills share` refuses forwarded and remote invocations, so their hosts cannot publish skills.
    if (
      settings?.agentSkillSharingEnabled === true &&
      !process.env.ORCA_CLI_CWD &&
      !ctx.client.isRemote
    ) {
      enabled.add('skill-publishing')
    }
  } catch {
    // Orca not running, sandboxed, or an older host; the publish commands still enforce the real gate.
  }
  return enabled
}
