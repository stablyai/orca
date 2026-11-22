import type { ShellDialogs } from './shell-dialogs-contract'

// Native screens present their own; only the shell page, whose sibling asks the shell, borrows its dialogs.
export function useShellDialogs(): ShellDialogs | null {
  return null
}
