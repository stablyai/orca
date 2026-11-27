import { chmod, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CodexCliFreshnessTracker,
  parseCodexInitializeVersion
} from './codex-launched-cli-freshness'

describe('CodexCliFreshnessTracker', () => {
  it('parses Codex initialize userAgent versions and rejects malformed payloads', () => {
    expect(
      parseCodexInitializeVersion({
        userAgent: 'orca_desktop/0.172.0 (Mac OS 27.0.1; arm64) dumb (orca_desktop; 0.0.0)'
      })
    ).toBe('0.172.0')
    expect(parseCodexInitializeVersion({ userAgent: 'codex/v0.172.0-beta.1' })).toBe(
      '0.172.0-beta.1'
    )
    expect(parseCodexInitializeVersion({})).toBeNull()
    expect(parseCodexInitializeVersion({ userAgent: 'codex/not-a-version' })).toBeNull()
  })

  it('detects real symlink CLI upgrades and fails closed when the binary becomes unreadable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-codex-freshness-'))
    try {
      const v1 = join(dir, 'codex-v1')
      const v2 = join(dir, 'codex-v2')
      const link = join(dir, 'codex')
      await writeFile(v1, '#!/bin/sh\necho v1\n')
      await chmod(v1, 0o755)
      await writeFile(v2, '#!/bin/sh\necho v2-longer\n')
      await chmod(v2, 0o755)
      await symlink(v1, link)

      const tracker = new CodexCliFreshnessTracker()
      const launched = await tracker.captureLaunched(
        { command: link, cwd: dir, codexVersion: '0.171.0' },
        {}
      )
      expect(launched.stamp).not.toBeNull()
      expect(await tracker.isOutdated(launched)).toBe(false)

      await unlink(link)
      await symlink(v2, link)
      expect(await tracker.isOutdated(launched)).toBe(true)

      const relaunched = await tracker.captureLaunched(
        { command: link, cwd: dir, codexVersion: '0.172.0' },
        {}
      )
      expect(await tracker.isOutdated(relaunched)).toBe(false)

      await unlink(link)
      expect(await tracker.isOutdated(relaunched)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('detects shim upgrades via post-launch catalog versions without looping on stale observations', async () => {
    const tracker = new CodexCliFreshnessTracker()
    const noStamp = async () => null

    tracker.observeCatalogVersion(
      { command: '/shim/codex' },
      { userAgent: 'orca_desktop/0.171.0 (Mac OS)' }
    )
    const launchedV2 = await tracker.captureLaunched(
      { command: '/shim/codex', cwd: '/tmp', codexVersion: '0.172.0' },
      { userAgent: 'orca_desktop/0.172.0 (Mac OS)' },
      { executableStamp: noStamp }
    )
    expect(await tracker.isOutdated(launchedV2, { executableStamp: noStamp })).toBe(false)

    tracker.observeCatalogVersion(
      { command: '/custom/codex', customCommand: true },
      { userAgent: 'orca_desktop/0.173.0 (Mac OS)' }
    )
    expect(await tracker.isOutdated(launchedV2, { executableStamp: noStamp })).toBe(false)

    tracker.observeCatalogVersion(
      { command: '/other/path/codex' },
      { userAgent: 'orca_desktop/0.173.0 (Mac OS)' }
    )
    expect(await tracker.isOutdated(launchedV2, { executableStamp: noStamp })).toBe(true)

    const relaunchedV3 = await tracker.captureLaunched(
      { command: '/other/path/codex', cwd: '/tmp', codexVersion: '0.173.0' },
      { userAgent: 'orca_desktop/0.173.0 (Mac OS)' },
      { executableStamp: noStamp }
    )
    expect(await tracker.isOutdated(relaunchedV3, { executableStamp: noStamp })).toBe(false)
  })

  it('rechecks version once after an in-app CLI update epoch advances on a static shim', async () => {
    const tracker = new CodexCliFreshnessTracker()
    const noStamp = async () => null
    let versionCalls = 0
    let reportedVersion = '0.171.0'
    const readVersion = async () => {
      versionCalls += 1
      return { version: reportedVersion, output: `codex-cli ${reportedVersion}` }
    }

    const launched = await tracker.captureLaunched(
      { command: '/volta/bin/codex', cwd: '/tmp', codexVersion: '0.171.0' },
      {},
      { executableStamp: noStamp }
    )
    expect(await tracker.isOutdated(launched, { executableStamp: noStamp, readVersion })).toBe(
      false
    )
    expect(versionCalls).toBe(0)

    tracker.noteCliUpdateFinished()
    expect(await tracker.isOutdated(launched, { executableStamp: noStamp, readVersion })).toBe(
      false
    )
    expect(await tracker.isOutdated(launched, { executableStamp: noStamp, readVersion })).toBe(
      false
    )
    expect(versionCalls).toBe(1)

    reportedVersion = '0.172.0'
    tracker.noteCliUpdateFinished()
    expect(await tracker.isOutdated(launched, { executableStamp: noStamp, readVersion })).toBe(true)
    expect(versionCalls).toBe(2)
  })
})
