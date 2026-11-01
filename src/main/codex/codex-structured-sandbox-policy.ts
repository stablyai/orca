import { z } from 'zod'

const sandboxPolicy = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('readOnly'), networkAccess: z.boolean().optional() }),
  z.looseObject({ type: z.literal('dangerFullAccess') }),
  z.looseObject({
    type: z.literal('workspaceWrite'),
    writableRoots: z.array(z.string()),
    networkAccess: z.boolean(),
    excludeTmpdirEnvVar: z.boolean(),
    excludeSlashTmp: z.boolean()
  }),
  z.looseObject({
    type: z.literal('externalSandbox'),
    networkAccess: z.enum(['enabled', 'restricted'])
  })
])

export type CodexSandboxPolicy = z.infer<typeof sandboxPolicy>

/** Replay the provider's complete policy, including fields a newer binary may add. */
export function readCodexSandboxPolicy(value: unknown): CodexSandboxPolicy | undefined {
  const parsed = sandboxPolicy.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
