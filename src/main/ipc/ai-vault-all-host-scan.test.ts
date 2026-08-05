import { describe, expect, it } from 'vitest'
import type { AiVaultListResult } from '../../shared/ai-vault-types'
import { scanAllAiVaultHosts } from './ai-vault-all-host-scan'

const EMPTY_RESULT: AiVaultListResult = {
  sessions: [],
  issues: [],
  scannedAt: '2026-07-29T00:00:00.000Z'
}

describe('scanAllAiVaultHosts', () => {
  it('keeps concurrent callers independently cancellable', async () => {
    const resolvers: ((result: AiVaultListResult) => void)[] = []
    const signals: AbortSignal[] = []
    const scanSsh = (_host: string, signal: AbortSignal) => {
      signals.push(signal)
      return new Promise<AiVaultListResult>((resolve) => resolvers.push(resolve))
    }
    const args = {
      sshHosts: ['ssh-1'],
      runtimeHosts: [] as string[],
      runtimeIssues: [],
      scanLocal: async () => EMPTY_RESULT,
      scanSsh,
      scanRuntime: async () => EMPTY_RESULT
    }

    const first = scanAllAiVaultHosts(args)
    const second = scanAllAiVaultHosts(args)

    expect(signals).toHaveLength(2)
    expect(signals.every((signal) => !signal.aborted)).toBe(true)
    resolvers.forEach((resolve) => resolve(EMPTY_RESULT))
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })
})
