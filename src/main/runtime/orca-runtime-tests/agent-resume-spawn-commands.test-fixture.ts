import type { vi } from 'vitest'

export function spawnedCommands(spawn: ReturnType<typeof vi.fn>): string[] {
  return spawn.mock.calls.map(([args]: unknown[]) =>
    typeof args === 'object' && args !== null && 'command' in args ? String(args.command ?? '') : ''
  )
}

export function resumeSpawns(spawn: ReturnType<typeof vi.fn>): number {
  return spawnedCommands(spawn).filter((command) => command.includes('provider-session-1')).length
}
