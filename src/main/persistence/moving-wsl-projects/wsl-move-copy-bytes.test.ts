import { describe, expect, it } from 'vitest'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { wslMoveCopyBytes } from './wsl-move-driver-transfer'

describe('wslMoveCopyBytes', () => {
  it('counts the terminal history sent while staging, not only the blobs', () => {
    // A 262 KB move showed 413 B.
    const cutover = wslMoveCutoverFixture('move-1', 'destination-staged')
    const withHistory = {
      manifest: {
        ...cutover.manifest,
        payload: {
          ...cutover.manifest.payload,
          dormantState: {
            ...cutover.manifest.payload.dormantState!,
            terminalScrollbackSnapshots: [
              { tabId: 't', leafId: 'l', ref: 'r', sha256: '0'.repeat(64), byteLength: 261_834 }
            ]
          }
        }
      }
    }
    expect(wslMoveCopyBytes(withHistory, [{ byteLength: 413 }])).toEqual({
      snapshotBytes: 261_834,
      bytesTotal: 262_247
    })
  })
})
