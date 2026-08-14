// STA-4048: a generic braille progress title is activity, not guarded-send authority.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { assertTerminalAgentSendable } from './rpc/terminal-agent-send-guard'
import {
  detectAgentStatusFromTitle,
  isBrailleSpinnerOnlyAgentTitle
} from '../../shared/agent-detection'
import type { TuiAgent } from '../../shared/tui-agent'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TAB_ID = 'tab-1'
const WORKTREE_ID = 'wt-1'
const PTY_ID = 'pty-1'

const BRAILLE_ONLY_TITLE = '⠙ Deploying release 4.2'
const MIXED_SPINNER_ONLY_TITLE = '⠙◑ Deploying release 4.2'
const BRAILLE_WITH_IDENTITY_TITLE = '⠂ Claude Code'
const CURSOR_SYNTHETIC_TITLE = '⠋ Cursor Agent'
const PI_SYNTHETIC_TITLE = '⠇ Pi'
const DROID_SYNTHETIC_TITLE = '⠋ Droid'
const ANDROID_PATH_TITLE = '⠋ android build'

type HostSurface = {
  connectionId?: string | null
  folderWorkspace?: { id: string; path: string } | null
  isWsl?: boolean
}

async function createRuntimeWithTitle(
  paneTitle: string,
  foregroundProcess: string | null,
  launchAgent?: TuiAgent,
  verifiedLaunch = true,
  host: HostSurface = {}
): Promise<{
  runtime: OrcaRuntimeService
  handle: string
  getForegroundProcess: ReturnType<typeof vi.fn>
}> {
  const runtime = new OrcaRuntimeService(null)
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
  }
  vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: WORKTREE_ID,
    path: '/repo/app',
    connectionId: host.connectionId ?? null,
    repo: null,
    folderWorkspace: host.folderWorkspace ?? null
  })
  const getForegroundProcess = vi.fn(async () => foregroundProcess)
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID, incarnationId: 'initial-incarnation' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess
  })
  const terminal = await runtime.createTerminal(`id:${WORKTREE_ID}`, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    title: 'Terminal',
    ...(launchAgent
      ? {
          launchAgent,
          ...(verifiedLaunch
            ? { launchConfig: { agentCommand: launchAgent, agentArgs: '', agentEnv: {} } }
            : {})
        }
      : {})
  })
  if (host.isWsl) {
    const pty = (runtime as unknown as { ptysById: Map<string, { isWsl: boolean }> }).ptysById.get(
      PTY_ID
    )
    if (pty) {
      pty.isWsl = true
    }
  }
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: PTY_ID,
        paneTitle
      }
    ]
  })
  return { runtime, handle: terminal.handle, getForegroundProcess }
}

const AUTHORIZED = 'authorized'

async function guardedSendResult(runtime: OrcaRuntimeService, handle: string): Promise<string> {
  try {
    await assertTerminalAgentSendable({ runtime, handle, assertWritable: () => {} })
    return AUTHORIZED
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('braille title send authorization (STA-4048)', () => {
  it('treats a braille-only non-agent title as activity, not identity', () => {
    expect(isBrailleSpinnerOnlyAgentTitle(BRAILLE_ONLY_TITLE)).toBe(true)
    expect(isBrailleSpinnerOnlyAgentTitle(BRAILLE_WITH_IDENTITY_TITLE)).toBe(false)
    expect(isBrailleSpinnerOnlyAgentTitle(CURSOR_SYNTHETIC_TITLE)).toBe(false)
    expect(isBrailleSpinnerOnlyAgentTitle(PI_SYNTHETIC_TITLE)).toBe(false)
    expect(isBrailleSpinnerOnlyAgentTitle(DROID_SYNTHETIC_TITLE)).toBe(false)
    expect(isBrailleSpinnerOnlyAgentTitle(ANDROID_PATH_TITLE)).toBe(true)
    expect(isBrailleSpinnerOnlyAgentTitle(MIXED_SPINNER_ONLY_TITLE)).toBe(true)
    expect(detectAgentStatusFromTitle(BRAILLE_ONLY_TITLE)).toBe('working')
  })

  it('refuses a guarded send when a braille spinner is the only agent evidence', async () => {
    const { runtime, handle } = await createRuntimeWithTitle(BRAILLE_ONLY_TITLE, 'node')

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      isRunningAgent: false
    })
    await expect(guardedSendResult(runtime, handle)).resolves.toBe('terminal_guard_no_agent')
  })

  it.each([
    ['unreadable foreground (SSH / folder / WSL / relay)', {}, null],
    ['SSH connection id', { connectionId: 'ssh-host-1' }, null],
    ['folder workspace', { folderWorkspace: { id: 'folder-1', path: '/tmp/project' } }, null],
    ['Windows WSL PTY', { isWsl: true }, null]
  ] as const)(
    'refuses a braille-only title with no launch record on %s',
    async (_label, host, foreground) => {
      const { runtime, handle } = await createRuntimeWithTitle(
        BRAILLE_ONLY_TITLE,
        foreground,
        undefined,
        true,
        host
      )

      await expect(guardedSendResult(runtime, handle)).resolves.toBe('terminal_guard_no_agent')
    }
  )

  it('authorizes a guarded send when the foreground process is a recognized agent', async () => {
    const { runtime, handle } = await createRuntimeWithTitle(BRAILLE_ONLY_TITLE, 'claude')

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      isRunningAgent: true,
      status: 'working'
    })
    await expect(guardedSendResult(runtime, handle)).resolves.toBe(AUTHORIZED)
  })

  it.each(['claude', 'pi', 'grok', 'codex'] as const)(
    'authorizes a verified %s launch when the foreground process is unavailable',
    async (launchAgent) => {
      const { runtime, handle, getForegroundProcess } = await createRuntimeWithTitle(
        BRAILLE_ONLY_TITLE,
        null,
        launchAgent
      )
      expect(
        (
          runtime as unknown as {
            ptysById: Map<string, { launchAgent: string | null; launchToken: string | null }>
          }
        ).ptysById.get(PTY_ID)
      ).toMatchObject({ launchAgent, launchToken: expect.any(String) })

      await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
        isRunningAgent: true,
        status: 'working'
      })
      await expect(guardedSendResult(runtime, handle)).resolves.toBe(AUTHORIZED)
      expect(getForegroundProcess).not.toHaveBeenCalled()
    }
  )

  it('does not trust an unverified launch hint', async () => {
    const { runtime, handle } = await createRuntimeWithTitle(
      BRAILLE_ONLY_TITLE,
      null,
      'claude',
      false
    )

    await expect(guardedSendResult(runtime, handle)).resolves.toBe('terminal_guard_no_agent')
  })

  it('does not carry managed identity into a replacement PTY incarnation', async () => {
    const { runtime, handle } = await createRuntimeWithTitle(BRAILLE_ONLY_TITLE, null, 'pi')
    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          { incarnationId: string | null; launchIncarnationId: string | null; launchToken: string }
        >
      }
    ).ptysById.get(PTY_ID)
    expect(pty).toMatchObject({
      incarnationId: 'initial-incarnation',
      launchIncarnationId: 'initial-incarnation'
    })

    runtime.onPtySpawned(PTY_ID, 'replacement-incarnation', { awaitsRegistration: false })

    expect(pty).toMatchObject({
      incarnationId: 'replacement-incarnation',
      launchIncarnationId: 'initial-incarnation',
      launchToken: expect.any(String)
    })
    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      isRunningAgent: false
    })
    await expect(guardedSendResult(runtime, handle)).resolves.toBe('terminal_guard_no_agent')
  })

  it('authorizes a guarded send when the busy title itself names the agent', async () => {
    const { runtime, handle } = await createRuntimeWithTitle(BRAILLE_WITH_IDENTITY_TITLE, null)

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      isRunningAgent: true,
      status: 'working'
    })
    await expect(guardedSendResult(runtime, handle)).resolves.toBe(AUTHORIZED)
  })

  it('authorizes Orca synthesized Droid working titles without a launch record', async () => {
    const { runtime, handle } = await createRuntimeWithTitle(DROID_SYNTHETIC_TITLE, null)

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      isRunningAgent: true,
      status: 'working'
    })
    await expect(guardedSendResult(runtime, handle)).resolves.toBe(AUTHORIZED)
  })

  it('does not treat an android path title as Droid identity', async () => {
    const { runtime, handle } = await createRuntimeWithTitle(ANDROID_PATH_TITLE, null)

    await expect(guardedSendResult(runtime, handle)).resolves.toBe('terminal_guard_no_agent')
  })

  it('refuses a mixed braille and quarter-circle title with no other identity', async () => {
    const { runtime, handle } = await createRuntimeWithTitle(MIXED_SPINNER_ONLY_TITLE, null)

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      isRunningAgent: false
    })
    await expect(guardedSendResult(runtime, handle)).resolves.toBe('terminal_guard_no_agent')
  })

  it('still authorizes Orca synthetic Cursor and Pi spinner titles', async () => {
    const cursor = await createRuntimeWithTitle(CURSOR_SYNTHETIC_TITLE, null)
    await expect(guardedSendResult(cursor.runtime, cursor.handle)).resolves.toBe(AUTHORIZED)

    const pi = await createRuntimeWithTitle(PI_SYNTHETIC_TITLE, null)
    await expect(guardedSendResult(pi.runtime, pi.handle)).resolves.toBe(AUTHORIZED)
  })

  it('keeps the braille glyph a working activity signal', () => {
    expect(detectAgentStatusFromTitle(BRAILLE_ONLY_TITLE)).toBe('working')
    expect(detectAgentStatusFromTitle(BRAILLE_WITH_IDENTITY_TITLE)).toBe('working')
  })
})
