import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots } from './session-scanner-test-fixtures'
import { antigravitySessionOrigin } from '../../shared/antigravity-session-origin'

it.skipIf(process.env.ORCA_REAL_ANTIGRAVITY_HISTORY !== '1')(
  'scans bounded existing official artifacts without publishing their content',
  async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'orca-agy-recorded-'))
    try {
      const home = homedir()
      const rootPresence = await Promise.all(
        ['antigravity-cli', 'antigravity-ide', 'antigravity'].map(async (origin) => {
          const present = await stat(join(home, '.gemini', origin, 'brain')).then(
            (value) => value.isDirectory(),
            () => false
          )
          return { origin, present }
        })
      )
      const result = await scanAiVaultSessions({
        ...isolatedScanRoots(sandbox),
        antigravityBrainDir: join(home, '.gemini', 'antigravity-cli', 'brain'),
        antigravityAppHome: home,
        includeAntigravityIdeSessions: true,
        limit: 5,
        limitPerAgent: 10
      })
      expect(result.issues.length).toBe(0)
      expect(result.sessions.length).toBeGreaterThan(0)
      expect(result.sessions.length).toBeLessThanOrEqual(5)
      expect(result.sessions.some((session) => session.messageCount > 0)).toBe(true)
      const proof = {
        provenance:
          'Existing official recorded artifacts through production scanner; no live IDE/model claim',
        rootPresence,
        sessionCount: result.sessions.length,
        issueCount: result.issues.length,
        origins: result.sessions.map((session) => ({
          origin: antigravitySessionOrigin(session.filePath),
          fullTranscript: session.filePath.endsWith('transcript_full.jsonl'),
          messageCount: session.messageCount,
          hasWorkspace: session.cwd !== null,
          cliResume: session.resumeCommand.includes('--conversation')
        }))
      }
      if (process.env.ORCA_ANTIGRAVITY_HISTORY_PROOF_PATH) {
        await writeFile(
          process.env.ORCA_ANTIGRAVITY_HISTORY_PROOF_PATH,
          `${JSON.stringify(proof, null, 2)}\n`
        )
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  }
)
