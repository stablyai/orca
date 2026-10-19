import { describe, expect, it } from 'vitest'
import { ORCAD_WINDOWS_PROCESS_TREE_FILENAME } from '../../shared/orcad-artifacts'
import { relayArtifactFilenames } from './relay-install-artifacts'

describe('relay install artifacts', () => {
  it('keeps the optional process-table addon out of the required set', () => {
    // A complete install never had to contain it: only a Windows build machine could emit it.
    expect(relayArtifactFilenames(true)).not.toContain(ORCAD_WINDOWS_PROCESS_TREE_FILENAME)
    expect(relayArtifactFilenames(false)).not.toContain(ORCAD_WINDOWS_PROCESS_TREE_FILENAME)
  })

  it('requires the Windows-only patches only on Windows', () => {
    expect(relayArtifactFilenames(true)).toContain('relay.js')
    expect(relayArtifactFilenames(true)).toContain('node-pty-1.1.0-console-list-agent-patch.cjs')
    expect(relayArtifactFilenames(false)).not.toContain(
      'node-pty-1.1.0-console-list-agent-patch.cjs'
    )
  })

  it('lists the pty-master cloexec patch on every platform', () => {
    for (const isWindows of [true, false]) {
      expect(relayArtifactFilenames(isWindows)).toContain('node-pty-1.1.0-master-cloexec-patch.cjs')
    }
  })
})
