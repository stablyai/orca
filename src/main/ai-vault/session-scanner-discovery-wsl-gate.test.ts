import { describe, expect, it } from 'vitest'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { walkSessionFiles } from './session-scanner-discovery'

describe('walkSessionFiles WSL gate refusals', () => {
  it('rethrows gate refusals instead of reporting an empty tree', async () => {
    const refusal = new WslTranscriptFsError('timeout', 'slow share')
    await expect(
      walkSessionFiles('\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions', 'codex', [], {
        extensions: new Set(['.jsonl']),
        readDirectory: async () => {
          throw refusal
        }
      })
    ).rejects.toBe(refusal)
  })

  it('still treats ordinary readdir failures as an empty tree', async () => {
    await expect(
      walkSessionFiles('/missing/root', 'codex', [], {
        extensions: new Set(['.jsonl']),
        readDirectory: async () => {
          throw Object.assign(new Error('no such directory'), { code: 'ENOENT' })
        }
      })
    ).resolves.toEqual([])
  })
})
