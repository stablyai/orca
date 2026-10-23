import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { buildPtyIpcSpawnOptions } from './spawn-options'
import { createPtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'

const SESSION_ID = '0195f2ce-1111-4000-8000-000000000001'
const TRANSCRIPT = `/home/dev/.claude/projects/-home-dev-repo/${SESSION_ID}.jsonl`

async function transcriptGivenToProvider(
  overrides: Partial<PtySpawnIpcArgs>
): Promise<string | undefined> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: buildPtyIpcSpawnOptions only reads the members stubbed here; the rest belong to later spawn stages this test never runs.
  const deps = {
    transitionSpawnHiddenRendererPtyDeliveryState: vi.fn(),
    getSettings: () => getDefaultSettings('/tmp'),
    runtime: { registerPreAllocatedHandleForPty: vi.fn() }
  } as unknown as PtySpawnIpcDeps
  const ctx = createPtyIpcSpawnState(deps, {
    cols: 80,
    rows: 24,
    command: `claude '--resume' '${SESSION_ID}'`,
    launchAgent: 'claude',
    resumeProviderSession: { key: 'session_id', id: SESSION_ID, transcriptPath: TRANSCRIPT },
    ...overrides
  })
  ctx.env = {}
  // Why: the env stage this test skips is what resolves the launch line.
  ctx.launchCommand = ctx.args.command
  await buildPtyIpcSpawnOptions(ctx)
  return ctx.spawnOptions.claudeResumeTranscriptPath
}

describe('renderer pty spawn: Claude resume transcript', () => {
  it('names the resumed transcript so a revived shell can start in its project', async () => {
    await expect(transcriptGivenToProvider({})).resolves.toBe(TRANSCRIPT)
  })

  it('leaves SSH panes and other agents to their own folder rules', async () => {
    await expect(transcriptGivenToProvider({ connectionId: 'ssh-1' })).resolves.toBeUndefined()
    await expect(
      transcriptGivenToProvider({ launchAgent: 'codex', command: `codex resume ${SESSION_ID}` })
    ).resolves.toBeUndefined()
  })
})
