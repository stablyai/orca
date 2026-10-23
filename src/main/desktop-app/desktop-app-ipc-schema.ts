import { z } from 'zod'
import type {
  DesktopAppAgentBlock,
  DesktopAppInput,
  DesktopAppTarget
} from '../../shared/desktop-app-types'

// Why: the preload hands these straight from the renderer; they are parsed here because input
// injection reaches other apps and TypeScript types do not exist at the IPC boundary.
const idSchema = z.number().int().positive().max(2_147_483_647)

const targetSchema = z.object({ windowId: idSchema, pid: idSchema })

const inputSchema: z.ZodType<DesktopAppInput> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('click'),
    x: z.number().finite(),
    y: z.number().finite(),
    button: z.enum(['left', 'right']),
    clickCount: z.number().int().min(1).max(3)
  }),
  z.object({
    kind: z.literal('scroll'),
    x: z.number().finite(),
    y: z.number().finite(),
    deltaX: z.number().finite(),
    deltaY: z.number().finite()
  }),
  z.object({ kind: z.literal('text'), text: z.string().max(10_000) }),
  z.object({ kind: z.literal('key'), key: z.string().min(1).max(64) })
])

const sendInputSchema = targetSchema.extend({ input: inputSchema })

const agentBlockSchema = z.object({
  pid: idSchema,
  appName: z.string().max(256),
  bundleId: z.string().max(256).nullable()
})

function parseArgs<T>(schema: z.ZodType<T>, value: unknown, channel: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`${channel}: invalid arguments`)
  }
  return parsed.data
}

export function parseTargetArgs(value: unknown, channel: string): DesktopAppTarget {
  return parseArgs(targetSchema, value, channel)
}

export function parseSendInputArgs(
  value: unknown,
  channel: string
): DesktopAppTarget & { input: DesktopAppInput } {
  return parseArgs(sendInputSchema, value, channel)
}

export function parseAgentBlockArgs(value: unknown, channel: string): DesktopAppAgentBlock {
  return parseArgs(agentBlockSchema, value, channel)
}

export function parsePidArgs(value: unknown, channel: string): { pid: number } {
  return parseArgs(z.object({ pid: idSchema }), value, channel)
}
