import { expect, it, vi } from 'vitest'
import { readCodexExecutionExecutable } from './codex-execution-executable'
vi.mock('./codex-cli-installation-error', () => ({
  readCodexCliVersion: vi.fn().mockResolvedValue({ version: '0.167.2' })
}))
it.skipIf(process.platform !== 'darwin')(
  'hashes the native resolved executable and refuses wrappers or prefixes',
  async () => {
    const identity = await readCodexExecutionExecutable(
      process.execPath,
      [],
      process.cwd(),
      undefined
    )
    expect(identity).toMatchObject({
      version: '0.167.2',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    await expect(
      readCodexExecutionExecutable(import.meta.filename, [], process.cwd(), undefined)
    ).rejects.toThrow('native macOS executable')
    await expect(
      readCodexExecutionExecutable(process.execPath, ['wrapper'], process.cwd(), undefined)
    ).rejects.toThrow('native executable')
  }
)
