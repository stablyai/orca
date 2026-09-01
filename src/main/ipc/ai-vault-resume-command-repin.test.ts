import { describe, expect, it, vi } from 'vitest'
import type { AiVaultListArgs, AiVaultListResult } from '../../shared/ai-vault-types'
import type { AgentLaunchVaultResumeEntry } from '../../shared/agent-launch-spawn-request'
import type { AiVaultSessionResumePreparation } from '../../shared/ai-vault-resume-preparation'
import { resolveVaultResumeCopyCommand } from '../agent-launch/agent-launch-vault-resume'
import { revalidateAiVaultResumeEntry } from './ai-vault-resume-command'

vi.mock('electron', () => ({ app: { on: vi.fn() }, ipcMain: { handle: vi.fn() } }))

// The session bridge hardlinks one rollout into every per-account home and vault
// dedup keeps an arbitrary alias, so the OWNING home here is not the selected one.
const OWNING_HOME = '/tmp/orca/codex-accounts/account-a/home'
const SELECTED_HOME = '/tmp/orca/codex-accounts/account-b/home'
const FILE_PATH = `${OWNING_HOME}/sessions/2026/05/01/rollout-session-1.jsonl`

const ENTRY: AgentLaunchVaultResumeEntry = {
  executionHostId: 'local',
  agent: 'codex',
  sessionId: 'session-1',
  filePath: FILE_PATH
}

function discoverOwningSession(): (args: AiVaultListArgs) => Promise<AiVaultListResult> {
  return vi.fn(
    async () =>
      ({
        sessions: [
          {
            id: 'codex:1',
            executionHostId: 'local',
            agent: 'codex',
            sessionId: 'session-1',
            cwd: '/repo/orca',
            filePath: FILE_PATH,
            codexHome: OWNING_HOME
          }
        ]
      }) as unknown as AiVaultListResult
  )
}

const repinToSelectedAccount: AiVaultSessionResumePreparation = async () => ({
  useRealCodexHome: false,
  substituteCodexHome: SELECTED_HOME
})

describe('revalidateAiVaultResumeEntry Codex account repin', () => {
  // The echoed entry carries identity only — no codexHome — so a client-side
  // repin cannot ride over it. If the host skips preparation, resume spawns
  // under account A's credentials while the UI shows B selected (STA-4607).
  it('repins the host-discovered session onto the selected account home', async () => {
    const session = await revalidateAiVaultResumeEntry(
      ENTRY,
      discoverOwningSession(),
      repinToSelectedAccount
    )

    expect(session?.codexHome).toBe(SELECTED_HOME)
    expect(session?.codexHome).not.toBe(OWNING_HOME)
  })

  it('keeps the discovered home when the host supplies no preparation', async () => {
    const session = await revalidateAiVaultResumeEntry(ENTRY, discoverOwningSession(), undefined)

    expect(session?.codexHome).toBe(OWNING_HOME)
  })

  // Pins the whole path, not just the seam: a repin dropped anywhere downstream
  // of revalidation still ships the wrong CODEX_HOME to the spawned pane.
  it('carries the repinned home into the assembled resume command', async () => {
    const session = await revalidateAiVaultResumeEntry(
      ENTRY,
      discoverOwningSession(),
      repinToSelectedAccount
    )
    expect(session).not.toBeNull()

    const result = resolveVaultResumeCopyCommand({
      entry: ENTRY,
      sessions: [session!],
      hostPlatform: 'darwin'
    })

    expect(result.status).toBe('ok')
    const command = result.status === 'ok' ? result.command : ''
    expect(command).toContain(SELECTED_HOME)
    expect(command).not.toContain(OWNING_HOME)
  })
})
