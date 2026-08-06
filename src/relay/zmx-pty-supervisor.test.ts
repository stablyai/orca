import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ZmxPtySupervisor, type ZmxPtySessionMetadata } from './zmx-pty-supervisor'

const tempDirs: string[] = []

function makeSupervisor(): { supervisor: ZmxPtySupervisor; metadataDir: string } {
  const storageRoot = mkdtempSync(join(tmpdir(), 'orca-zmx-metadata-'))
  tempDirs.push(storageRoot)
  return {
    supervisor: new ZmxPtySupervisor({
      executablePath: '/usr/bin/true',
      namespace: 'test',
      storageRoot
    }),
    metadataDir: join(storageRoot, 'metadata')
  }
}

function makeMetadata(overrides: Partial<ZmxPtySessionMetadata> = {}): ZmxPtySessionMetadata {
  return {
    version: 1,
    id: 'pty-7',
    incarnationId: 'incarnation-1',
    initialCwd: '/srv/app',
    cols: 80,
    rows: 24,
    shell: '/bin/bash',
    envToDelete: [],
    gitCredentialPromptGuarded: false,
    createdAt: 1,
    ...overrides
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { force: true, recursive: true })
  }
})

describe('zmx session metadata', () => {
  it('round-trips identified panes with attach identity and agent owners', async () => {
    const { supervisor } = makeSupervisor()
    // Why: attachIdentity is an object; a string-shaped validator rejected it
    // and made every identified durable session unrecoverable after relay
    // replacement.
    const metadata = makeMetadata({
      paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
      tabId: 'tab-1',
      attachIdentity: { paneKey: 'tab-1:11111111-1111-4111-8111-111111111111', tabId: 'tab-1' },
      agentSessionOwners: [
        {
          claim: { kind: 'provider-session', agent: 'claude', sessionId: 'sess-1' },
          surface: { worktreeId: 'repo::/srv/app', tabId: 'tab-1', leafId: 'leaf-1' },
          generation: 'gen-1',
          phase: 'live',
          ptyId: 'pty-7'
        } as never
      ]
    })

    await supervisor.writeMetadata(metadata)

    await expect(supervisor.readMetadata('pty-7')).resolves.toEqual(metadata)
    await expect(supervisor.listMetadata()).resolves.toEqual([metadata])
  })

  it('rejects corrupt optional fields instead of throwing mid-sweep', async () => {
    const { supervisor, metadataDir } = makeSupervisor()
    await supervisor.prepare()
    writeFileSync(
      join(metadataDir, 'pty-9.json'),
      JSON.stringify({ ...makeMetadata({ id: 'pty-9' }), worktreeId: 42 })
    )

    await expect(supervisor.readMetadata('pty-9')).resolves.toBeNull()
  })

  it('ignores foreign json files in the metadata dir', async () => {
    const { supervisor, metadataDir } = makeSupervisor()
    await supervisor.writeMetadata(makeMetadata())
    writeFileSync(join(metadataDir, 'notes.json'), '{"not":"a session"}')

    await expect(supervisor.listMetadata()).resolves.toHaveLength(1)
  })
})
