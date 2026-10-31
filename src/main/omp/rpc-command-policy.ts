import { z } from 'zod'

const commandsSchema = z.object({
  commands: z.array(
    z.looseObject({
      name: z.string(),
      source: z.string().optional(),
      aliases: z.array(z.string()).optional()
    })
  )
})

export class OmpRpcCommandPolicy {
  private blocked = new Set<string>()

  update(answer: unknown): unknown {
    const result = commandsSchema.parse(answer)
    this.blocked = new Set(
      result.commands.flatMap((command) =>
        command.source === 'builtin' && ['move', 'wt', 'worktree'].includes(command.name)
          ? [command.name, ...(command.aliases ?? [])]
          : []
      )
    )
    return {
      ...result,
      commands: result.commands.filter((command) => !this.blocked.has(command.name))
    }
  }

  refuses(message: unknown): boolean {
    return (
      typeof message === 'string' &&
      this.blocked.has(/^\/([^\s:]+)(?:[\s:]|$)/.exec(message.trim())?.[1] ?? '')
    )
  }
}
