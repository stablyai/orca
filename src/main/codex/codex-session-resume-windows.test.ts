import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, toNamespacedPath } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareCodexSessionResume } from './codex-session-resume-preparation'

const windowsIt = process.platform === 'win32' ? it : it.skip
const cleanupPaths: string[] = []

afterEach(() => {
  for (const cleanupPath of cleanupPaths.splice(0)) {
    rmSync(cleanupPath, { recursive: true, force: true })
  }
})

describe('Codex session resume on native Windows', () => {
  windowsIt('resumes an extended-length rollout from its ordinary trusted home', async () => {
    const homePath = mkdtempSync(join(tmpdir(), 'orca-codex-resume-'))
    cleanupPaths.push(homePath)
    const rolloutPath = join(
      homePath,
      'sessions',
      '2026',
      '07',
      '20',
      'rollout-019f81b9-19a9-7651-a8d1-352d9420bd11.jsonl'
    )
    mkdirSync(dirname(rolloutPath), { recursive: true })
    writeFileSync(rolloutPath, '{"type":"session_meta"}\n')
    const transcriptPath = toNamespacedPath(rolloutPath)
    const resolveVerifiedResumeHome = vi.fn(async () => homePath)

    await expect(
      prepareCodexSessionResume({
        sessionId: '019f81b9-19a9-7651-a8d1-352d9420bd11',
        transcriptPath,
        trustedCodexHomes: [homePath],
        getSelectedAccountCodexHome: () => null,
        systemCodexHomePath: homePath,
        sharedRuntimeCodexHomePath: null,
        resolveVerifiedResumeHome
      })
    ).resolves.toEqual({ outcome: 'resume', codexHomePath: homePath })
    expect(resolveVerifiedResumeHome).toHaveBeenCalledWith({ homePath, transcriptPath })
  })
})
