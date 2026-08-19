import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { discoverFiles, walkSessionFiles } from './session-scanner-discovery'

// Why: an OS-level failure below the WSL gate's own deadline (e.g. a stalled
// UNC mount returning ECONNRESET) used to vanish as "this directory has no
// sessions" — indistinguishable from a genuinely empty tree, and it hid a
// real scan-latency regression (issues=0 on a 240s scan). A missing directory
// (ENOENT) is the normal, expected case for an agent the user never
// installed, so that one case must stay silent.
describe('walkSessionFiles records an issue for a swallowed non-ENOENT error', () => {
  it('stays silent for ENOENT (agent not installed)', async () => {
    const issues: AiVaultScanIssue[] = []
    await expect(
      walkSessionFiles('missing', 'codex', issues, {
        extensions: new Set(['.jsonl']),
        readDirectory: async () => {
          throw Object.assign(new Error('no such directory'), { code: 'ENOENT' })
        }
      })
    ).resolves.toEqual([])
    expect(issues).toEqual([])
  })

  it('stays silent for ENOENT expressed only in the message (no .code)', async () => {
    const issues: AiVaultScanIssue[] = []
    await expect(
      walkSessionFiles('missing', 'codex', issues, {
        extensions: new Set(['.jsonl']),
        readDirectory: async () => {
          throw new Error("ENOENT: no such file or directory, scandir 'missing'")
        }
      })
    ).resolves.toEqual([])
    expect(issues).toEqual([])
  })

  it('records a notice issue for a generic OS failure instead of an empty tree', async () => {
    const issues: AiVaultScanIssue[] = []
    await expect(
      walkSessionFiles('\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions', 'codex', issues, {
        extensions: new Set(['.jsonl']),
        readDirectory: async () => {
          throw Object.assign(new Error('connection reset by peer'), { code: 'ECONNRESET' })
        }
      })
    ).resolves.toEqual([])
    expect(issues).toEqual([
      {
        agent: 'codex',
        path: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions',
        message: 'connection reset by peer'
      }
    ])
  })

  it('records one issue per failing nested directory, at that directory path', async () => {
    const issues: AiVaultScanIssue[] = []
    const nestedDir = join('root', 'ok')
    const failingDir = join('root', 'ok', 'nested')
    const entries = new Map([
      ['root', [{ name: 'ok', isDirectory: () => true, isFile: () => false }]],
      [nestedDir, [{ name: 'nested', isDirectory: () => true, isFile: () => false }]]
    ])
    await expect(
      walkSessionFiles('root', 'codex', issues, {
        extensions: new Set(['.jsonl']),
        readDirectory: async (dirPath) => {
          const found = entries.get(dirPath)
          if (found) {
            return found as never
          }
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        }
      })
    ).resolves.toEqual([])
    expect(issues).toEqual([{ agent: 'codex', path: failingDir, message: 'permission denied' }])
  })

  it('discoverFiles stays silent for a real, local, nonexistent root (agent not installed)', async () => {
    // A local path bypasses the WSL gate entirely (isWslUncPath is false), so
    // this hits the real fs.readdir — a fast, deterministic ENOENT, no gate
    // timers or network involved.
    const issues: AiVaultScanIssue[] = []
    await expect(
      discoverFiles({
        rootDir: 'C:\\definitely\\does\\not\\exist\\12345',
        limit: 10,
        agent: 'codex',
        issues,
        extensions: ['.jsonl']
      })
    ).resolves.toEqual({
      agent: 'codex',
      rootDir: 'C:\\definitely\\does\\not\\exist\\12345',
      files: []
    })
    expect(issues).toEqual([])
  })
})
