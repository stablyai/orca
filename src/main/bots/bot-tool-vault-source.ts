import { z } from 'zod'
import { getServerCredentialVault } from '../credentials/vault/server-credential-vault'

const PREFIX = 'server-vault:'
const bindingSchema = z.object({
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  id: z.uuid(),
  scheme: z.enum(['bearer', 'api-key'])
})
export type BotVaultBinding = z.infer<typeof bindingSchema>

export function isBotVaultSource(source: string | undefined): boolean {
  return source?.startsWith(PREFIX) ?? false
}

export function botVaultSource(binding: BotVaultBinding): string {
  return `${PREFIX}${JSON.stringify(binding)}`
}

export function botVaultHeader(
  scheme: BotVaultBinding['scheme'],
  value: string
): Record<string, string> | null {
  if (!/^[ -~]+$/.test(value) || value.trim() !== value) {
    return null
  }
  return scheme === 'bearer' ? { authorization: `Bearer ${value}` } : { 'x-api-key': value }
}

export async function resolveBotVaultHeader(
  source: string,
  url: string
): Promise<Record<string, string> | null> {
  try {
    const binding = bindingSchema.safeParse(JSON.parse(source.slice(PREFIX.length)))
    if (!binding.success || new URL(url).protocol !== 'https:') {
      return null
    }
    const { scope, id, scheme } = binding.data
    const result = await getServerCredentialVault(scope)?.readValue(id, 'secret')
    return result?.ok ? botVaultHeader(scheme, result.value) : null
  } catch {
    return null
  }
}
