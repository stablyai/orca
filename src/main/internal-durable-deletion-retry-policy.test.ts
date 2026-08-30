import { readFileSync } from 'node:fs'
import type * as nodeFsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findRawRecursiveRemovals } from '../shared/raw-recursive-removal-scan'
import { readSourceRegionBody } from '../shared/source-region-body'
import {
  WINDOWS_RM_MAX_RETRIES,
  transientLockRemovalOptions
} from '../shared/windows-transient-lock-removal'
import { deleteRelayPath } from '../relay/fs-path-mutation-requests'

/** Records the options every recursive removal hands Node, without performing the removal. */
const recorded = vi.hoisted(() => ({ rmCalls: [] as [string, unknown][] }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFsPromises>()
  return {
    ...actual,
    rm: (path: string, options: unknown) => {
      recorded.rmCalls.push([path, options])
      return Promise.resolve()
    }
  }
})

/**
 * The sibling guard covers deletions a person asked for. This one covers Orca's own durable state:
 * removals whose failure is silent at the time and only shows up later — as a directory a rename
 * can never be published over, as a completed operation reporting failure because its scratch
 * cleanup threw, or as state Orca can no longer find in order to reclaim it.
 *
 * Still deliberately not every recursive removal in `src/`. The disposable temp trees that sit in
 * `.catch(() => {})` or a `try { … } catch { /* best-effort *\/ }` are genuinely harmless, and the
 * darwin-only computer-use provider paths can never reach a Windows retry.
 */
const REPO_ROOT = join(__dirname, '..', '..')

/** A removal of Orca's own state, named by the region of the file that performs it. */
type InternalDurableDeletion = { file: string; region: string; breaks: string }

/** A failed removal blocks the rename or copy that was supposed to replace it. */
const BLOCKS_ITS_OWN_REPLACEMENT: InternalDurableDeletion[] = [
  {
    file: 'src/main/daemon/daemon-host-relocation.ts',
    region: 'export function materializeRelocatedDaemonHost',
    breaks: 'the daemon host never publishes over its stale copy'
  },
  {
    file: 'src/main/emulator/serve-sim-runtime-materializer.ts',
    region: 'export function materializeServeSimRuntime',
    breaks: 'a half-materialized serve-sim runtime can never be replaced'
  },
  {
    file: 'src/main/plugins/plugin-install-staging.ts',
    region: 'export async function installStagedPluginTree',
    breaks: 'a corrupted immutable plugin version stays unrepairable'
  },
  {
    file: 'src/main/codex/codex-home-paths.ts',
    region: 'function copySystemCodexResourceAsOwnedFallback',
    breaks: 'Codex keeps launching against a stale mirrored resource'
  },
  {
    file: 'src/main/codex/codex-managed-home-resource-copy-marker.ts',
    region: 'export function clearCopiedResourceMarker',
    breaks: 'an ownership marker outlives the copy it describes'
  }
]

/** A failed removal turns a result the caller already earned into a rejection. */
const REPORTS_A_FALSE_FAILURE: InternalDurableDeletion[] = [
  {
    file: 'src/main/native-chat/agent-session-journal/journal-epoch-replacement.ts',
    region: 'export async function replaceJournalEpoch',
    breaks: 'a published journal epoch reports failure'
  },
  {
    file: 'src/main/plugins/plugin-marketplace-fetch.ts',
    region: 'export async function fetchPluginMarketplace',
    breaks: 'a successful marketplace fetch reports failure'
  },
  {
    file: 'src/main/skills/skill-bundle-creation.ts',
    region: 'async function createSkillBundleArchiveUnobserved',
    breaks: 'a written skill bundle archive reports failure'
  },
  {
    file: 'src/main/skills/skill-package-creation.ts',
    region: 'async function createSkillPackageArchiveUnobserved',
    breaks: 'a written skill package archive reports failure'
  },
  {
    file: 'src/main/skills/skill-package-extraction.ts',
    region: 'export async function extractSkillPackageArchive',
    breaks: 'a rollback replaces the failure the caller needed to see'
  },
  {
    file: 'src/main/skills/skill-bundle-extraction.ts',
    region: 'export async function extractSkillBundleArchive',
    breaks: 'a rollback replaces the failure the caller needed to see'
  },
  {
    file: 'src/main/plugins/plugin-marketplace-installer.ts',
    region: 'async preview',
    breaks: 'a successful marketplace preview reports failure'
  },
  {
    file: 'src/main/computer/desktop-script-provider-client.ts',
    region: 'private async callBridge',
    breaks: 'a successful computer-use bridge call reports failure'
  },
  {
    file: 'src/main/skills/skill-package-download.ts',
    region: 'async function downloadSkillPackageGrantUnobserved',
    breaks: 'a rollback replaces the digest mismatch the caller needed to see'
  },
  {
    file: 'src/main/plugins/plugin-install.ts',
    region: 'export async function installPluginFromGit',
    breaks: 'an installed plugin reports failure'
  },
  {
    file: 'src/main/plugins/plugin-install.ts',
    region: 'export async function installPluginFromMarketplace',
    breaks: 'a marketplace-installed plugin reports failure'
  },
  {
    file: 'src/main/browser/browser-cookie-import.ts',
    region: 'async function importCookiesFromFirefox',
    breaks: "a finished Firefox cookie import reports 'could not import'"
  }
]

/** A failed removal strands state Orca can no longer find in order to reclaim it. */
const STRANDS_RECLAIMABLE_STATE: InternalDurableDeletion[] = [
  {
    file: 'src/main/skills/skill-share-preparation-service.ts',
    region: 'async release',
    breaks: 'a released share preparation is unreachable and never reclaimed'
  },
  {
    file: 'src/main/skills/skill-upload-staging-ownership.ts',
    region: 'private async cleanupAbandonedOwners',
    breaks: "one dead owner's directory blocks every skill upload"
  },
  {
    file: 'src/main/skills/skill-package-download.ts',
    region: 'async function prepareTemporaryRoot',
    breaks: "one dead process's leftover directory blocks every skill download"
  },
  {
    file: 'src/main/hermes/hook-service.ts',
    region: 'remove(): AgentHookInstallStatus',
    breaks: 'the Hermes hook stays enabled after the user removed it'
  },
  {
    file: 'src/main/orcad/electron-serve-browser-process.ts',
    region: 'async stop',
    breaks: "the stopped sidecar's profile directory is never reclaimed"
  },
  {
    file: 'src/main/browser/browser-client-download-relay.ts',
    region: 'const nodeRelayFilesystem',
    breaks: "a client-hosted page's downloaded bytes are never removed"
  }
]

const INTERNAL_DURABLE_DELETIONS = [
  ...BLOCKS_ITS_OWN_REPLACEMENT,
  ...REPORTS_A_FALSE_FAILURE,
  ...STRANDS_RECLAIMABLE_STATE
]

/** The body of `region` in `source`, or a failed expectation naming the region that moved. */
function readRegion(source: string, region: string): string {
  const body = readSourceRegionBody(source, region)
  expect(body, `region "${region}" is gone; re-point this guard at its new name`).not.toBeNull()
  return body ?? ''
}

describe('internal durable removals carry the Windows removal policy', () => {
  it.each(INTERNAL_DURABLE_DELETIONS)(
    'removes through the retrying helper, or else $breaks ($file)',
    ({ file, region }) => {
      const body = readRegion(readFileSync(join(REPO_ROOT, file), 'utf8'), region)
      expect(
        findRawRecursiveRemovals(body),
        `on Windows a raw recursive rm throws on a transiently held handle, and here that is silent until later. Use removeTree/removeTreeSync from src/shared/windows-transient-lock-removal.ts`
      ).toEqual([])
    }
  )

  it('every named region reads back a real body', () => {
    // Without this, every assertion above passes for a region that matched nothing.
    for (const { file, region } of INTERNAL_DURABLE_DELETIONS) {
      const body = readRegion(readFileSync(join(REPO_ROOT, file), 'utf8'), region)
      expect(body.length, `${file}#${region}`).toBeGreaterThan(60)
      expect(body, `${file}#${region}`).toMatch(/removeTree(Sync)?\(/)
    }
  })

  it('the scan still reports a region that forgot the retries', () => {
    // Positive control: the guard above is only meaningful if this shape reddens it.
    expect(
      findRawRecursiveRemovals(
        'async function publish(p) {\n  await rm(p, { recursive: true, force: true })\n}'
      )
    ).toEqual([2])
  })

  it('counts a spread of the shared policy as carrying the retries', () => {
    // The two conditionally-recursive deletes below spread the policy instead of calling removeTree.
    expect(
      findRawRecursiveRemovals(
        'const r = () => rm(p, { ...transientLockRemovalOptions(), recursive: !!recursive })'
      )
    ).toEqual([])
  })
})

describe('the file-explorer delete reaching a relay host', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    recorded.rmCalls.length = 0
  })

  const fenceless = {
    runWithRemovalFence: async (_path: string, remove: () => Promise<void>) => {
      await remove()
    }
  } as unknown as Parameters<typeof deleteRelayPath>[1]

  it('hands Node the retry count on Windows', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })

    await deleteRelayPath({ targetPath: REPO_ROOT, recursive: true }, fenceless)

    expect(recorded.rmCalls.at(-1)?.[1]).toEqual({
      recursive: true,
      force: true,
      maxRetries: WINDOWS_RM_MAX_RETRIES,
      retryDelay: expect.any(Number)
    })
  })

  it('keeps a non-recursive delete non-recursive', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })

    await deleteRelayPath({ targetPath: join(REPO_ROOT, 'package.json') }, fenceless)

    expect(recorded.rmCalls.at(-1)?.[1]).toEqual(
      expect.objectContaining({ recursive: false, maxRetries: WINDOWS_RM_MAX_RETRIES })
    )
  })

  it('leaves the call unchanged on macOS and Linux', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })

    await deleteRelayPath({ targetPath: REPO_ROOT, recursive: true }, fenceless)

    expect(recorded.rmCalls.at(-1)?.[1]).toEqual({ recursive: true, force: true })
  })

  it('leaves the shared policy untouched on non-Windows', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    expect(transientLockRemovalOptions()).toEqual({ recursive: true, force: true })
  })
})
