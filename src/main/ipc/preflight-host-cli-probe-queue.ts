import type { Mock } from 'vitest'

/** Queue one local preflight pass: git, gh, glab, and tea versions, then auth. */
export function queueHostCliProbe(mock: Mock, ghAuthenticated: boolean): void {
  mock
    .mockResolvedValueOnce({ stdout: 'git version 2.0.0\n' })
    .mockResolvedValueOnce({ stdout: 'gh version 2.0.0\n' })
    .mockResolvedValueOnce({ stdout: 'glab version 1.92.1\n' })
    .mockResolvedValueOnce({ stdout: 'tea version 0.9.0\n' })
  if (ghAuthenticated) {
    mock.mockResolvedValueOnce({ stdout: 'github.com\n  - Active account: true\n' })
  } else {
    mock.mockRejectedValueOnce({ stderr: 'You are not logged into any GitHub hosts.\n' })
  }
  mock
    .mockResolvedValueOnce({ stdout: 'Logged in to gitlab.com\n' })
    .mockResolvedValueOnce({ stdout: '[]\n' })
}
