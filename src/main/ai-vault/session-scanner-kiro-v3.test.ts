import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  discoverSessionSearchCandidates,
  sessionSearchRootListings
} from '../ai-vault-search/session-search-scan-roots'
import { scanAiVaultSessions } from './session-scanner'
import {
  KIRO_FIXTURE_SESSION_ID,
  KIRO_V3_FIXTURE_MANIFEST,
  KIRO_V3_FIXTURE_SESSION_ID,
  writeKiroSessionFixture,
  writeKiroV3SessionFixture
} from './session-scanner-kiro-fixtures'
import { isolatedScanRoots } from './session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.resetModules()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

const DECOY_SESSION_ID = 'sess_00000000-0000-4000-8000-000000000000'

async function writeDecoyManifest(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'session.json'),
    JSON.stringify({ ...KIRO_V3_FIXTURE_MANIFEST, id: DECOY_SESSION_ID })
  )
}

/** Kiro's real nesting: the `kiro-cli chat` store is `cli/` inside the V3 sessions root. */
async function nestedKiroRoots() {
  const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-kiro-v3-'))
  tempRoots.push(root)
  const sessionsDir = join(root, 'kiro-home', 'sessions')
  const roots = {
    ...isolatedScanRoots(root),
    kiroSessionsDir: join(sessionsDir, 'cli'),
    kiroV3SessionsDir: sessionsDir
  }
  await writeKiroSessionFixture(roots)
  const manifestPath = await writeKiroV3SessionFixture(sessionsDir)
  // Manifests that would list if the walk entered these directories.
  await writeDecoyManifest(join(sessionsDir, '5fab923ac92fb45c', '.index', DECOY_SESSION_ID))
  await writeFile(join(sessionsDir, '5fab923ac92fb45c', '.index', '.lock'), '')
  await writeDecoyManifest(join(sessionsDir, '.cache', DECOY_SESSION_ID))
  await writeDecoyManifest(join(sessionsDir, KIRO_FIXTURE_SESSION_ID, DECOY_SESSION_ID))
  await writeDecoyManifest(join(sessionsDir, 'cli', KIRO_FIXTURE_SESSION_ID, DECOY_SESSION_ID))
  return { roots, sessionsDir, manifestPath }
}

describe('Kiro V3 session store', () => {
  it('lists each store once beside the other, skipping cli, UUID and dot directories', async () => {
    const { roots, manifestPath } = await nestedKiroRoots()

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin', limit: 20 })

    expect(result.issues).toEqual([])
    const kiro = result.sessions.filter((session) => session.agent === 'kiro')
    expect(kiro.map((session) => session.sessionId).sort()).toEqual(
      [KIRO_FIXTURE_SESSION_ID, KIRO_V3_FIXTURE_SESSION_ID].sort()
    )
    const v3 = kiro.find((session) => session.sessionId === KIRO_V3_FIXTURE_SESSION_ID)
    expect(v3).toMatchObject({
      filePath: manifestPath,
      title: 'Execute PowerShell Sleep Command',
      model: 'claude-opus-5.5',
      messageCount: 2,
      resumeCommand: `cd '/private/tmp/kiro-test-proj' && kiro-cli chat --tui --resume-id '${KIRO_V3_FIXTURE_SESSION_ID}'`
    })
    const v2 = kiro.find((session) => session.sessionId === KIRO_FIXTURE_SESSION_ID)
    expect(v2).toMatchObject({
      title: 'Kiro title',
      model: 'kiro-model',
      resumeCommand: `cd '/tmp/kiro' && kiro-cli chat --tui --resume-id '${KIRO_FIXTURE_SESSION_ID}'`
    })
  })

  it('attributes each store to its own root in the search listing', async () => {
    const { roots, sessionsDir } = await nestedKiroRoots()

    const { discoveries } = await discoverSessionSearchCandidates(roots, {
      limitPerAgent: Number.POSITIVE_INFINITY
    })
    const byRoot = Object.fromEntries(
      sessionSearchRootListings(roots, discoveries).map((one) => [one.root, one.files])
    )

    expect(byRoot[join(sessionsDir, 'cli')]).toBe(1)
    expect(byRoot[sessionsDir]).toBe(1)
  })

  it('keeps the V3 root under the home directory when KIRO_HOME moves the cli store', async () => {
    const kiroHome = join(tmpdir(), 'orca-kiro-home-elsewhere')
    vi.stubEnv('KIRO_HOME', kiroHome)
    vi.resetModules()
    const { KIRO_AGENT_SOURCE } = await import('./session-scanner-kiro-sources.js')

    expect(KIRO_AGENT_SOURCE.rootDirs({}, ['/wsl/home/ada'])).toEqual([
      join(kiroHome, 'sessions', 'cli'),
      join('/wsl/home/ada', '.kiro', 'sessions', 'cli'),
      join(homedir(), '.kiro', 'sessions'),
      join('/wsl/home/ada', '.kiro', 'sessions')
    ])
  })
})
