import { z } from 'zod'

export const SshRouteCredentialsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('password'), password: z.string().min(1).max(4096) }),
  z.object({
    kind: z.literal('key'),
    privateKey: z.string().min(1).max(32768),
    passphrase: z.string().max(4096)
  })
])
export type SshRouteCredentials = z.infer<typeof SshRouteCredentialsSchema>
