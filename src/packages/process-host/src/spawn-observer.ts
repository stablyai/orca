// Main installs diagnostics here; daemon, relay, and CLI cannot depend on main code.
export type SpawnObserver = (command: string, args: readonly string[], blockMs: number) => void

let observer: SpawnObserver | null = null

export function setSpawnObserver(next: SpawnObserver | null): void {
  observer = next
}

export function notifySpawnObserver(
  command: string,
  args: readonly string[],
  blockMs: number
): void {
  observer?.(command, args, blockMs)
}

export function hasSpawnObserver(): boolean {
  return observer !== null
}
