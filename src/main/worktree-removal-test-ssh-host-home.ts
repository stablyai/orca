import { setWorktreeRemovalSshHostHomeResolver } from './worktree-removal-execution-host-route'

/** The `$HOME` the worktree-removal suites' SSH hosts report. */
export const TEST_SSH_HOST_HOME = '/home/remote-user'

/**
 * Makes a suite's SSH hosts answer the removal guards' home question.
 *
 * Every suite that registers an SSH provider is modelling a connected relay session, and a
 * connected session has always read the host's `$HOME`. Without it the guards refuse the delete —
 * the right answer for a host that never answered, the wrong fixture for one that did.
 * Deliberately not wired from `ipc/worktrees-test-module-mocks`: that module is imported from
 * `vi.mock` factories, and reaching the production route module from there pulls in
 * `providers/ssh-git-dispatch` while it is being mocked, which deadlocks the module runner.
 */
export function resetWorktreeTestSshHostHome(): void {
  setWorktreeRemovalSshHostHomeResolver(() => TEST_SSH_HOST_HOME)
}
