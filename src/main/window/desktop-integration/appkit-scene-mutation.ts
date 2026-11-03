// macOS 26 scene updates can deadlock inside AppKit dispatch; defer to a fresh event-loop turn.
export function deferAppKitSceneMutation(mutate: () => void): void {
  setTimeout(mutate, 0)
}
