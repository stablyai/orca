import { describe, expect, it } from 'vitest'
import { readCodexAccountRestartRefusalId } from '../../../../shared/agent-accounts/codex/codex-account-restart-stop'
import {
  CodexAccountRestartResumeUnavailableError,
  resolveCodexAccountRestartResume
} from './codex-account-restart-resume-gate'
import {
  CodexAccountRestartStops,
  codexAccountRestartPaneKey,
  type CodexRestartStopOutcome
} from './codex-account-restart-stops'

const ORIGINAL_TRANSCRIPT = '/old-home/sessions/2026/11/01/rollout-2026-11-01-thread-1.jsonl'
const SELECTED_HOME_COPY = '/new-home/sessions/2026/11/01/rollout-2026-11-01-thread-1.jsonl'
const pane = { worktreeId: 'wt', tabId: 'tab', leafId: 'leaf' }

function admitStop(stops: CodexAccountRestartStops, outcome: CodexRestartStopOutcome = 'ended') {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const result = stops.request(
    { ...pane, ptyId: 'pty-a', opId: 'op-1' },
    {
      resolveOccupant: () => ({
        ptyId: 'pty-a',
        incarnationId: 'inc-a',
        provenance: { threadId: 'thread-1', transcriptPath: ORIGINAL_TRANSCRIPT }
      }),
      stop: async () => {
        await held
        return outcome
      }
    }
  )
  return { result, release }
}

function resume(
  stops: CodexAccountRestartStops,
  overrides: Partial<Parameters<typeof resolveCodexAccountRestartResume>[0]> = {}
) {
  return resolveCodexAccountRestartResume(
    {
      launchAgent: 'codex',
      resumeProviderSession: { key: 'session_id', id: 'thread-1' },
      ...pane,
      preAdopted: false,
      replacesPtyId: undefined,
      connectionId: null,
      selectionRuntime: 'host',
      isDaemonHostSpawn: true,
      ...overrides
    },
    stops
  )
}

async function readRefusal(stops: CodexAccountRestartStops): Promise<string> {
  try {
    await resume(stops, { launchAgent: undefined, resumeProviderSession: undefined })
  } catch (error) {
    if (error instanceof CodexAccountRestartResumeUnavailableError) {
      const refusalId = readCodexAccountRestartRefusalId(error.message)
      if (refusalId) {
        return refusalId
      }
    }
    throw error
  }
  throw new Error('Expected a refusal tied to the failed resume')
}

describe('account restart resume reopens the exact conversation', () => {
  it('resumes the captured transcript on the selected account, never another home copy', async () => {
    const stops = new CodexAccountRestartStops()
    const { result, release } = admitStop(stops)
    release()
    await result
    const decision = await resume(stops, {
      resumeProviderSession: {
        key: 'session_id',
        id: 'thread-1',
        transcriptPath: SELECTED_HOME_COPY
      }
    })
    expect(decision.resumeOnSelectedAccount).toBe(true)
    expect(decision.providerSession).toEqual({
      key: 'session_id',
      id: 'thread-1',
      transcriptPath: ORIGINAL_TRANSCRIPT
    })
  })

  it('waits for the stop to settle before deciding the account', async () => {
    const stops = new CodexAccountRestartStops()
    const { result, release } = admitStop(stops)
    let decided = false
    const decision = resume(stops).then((value) => {
      decided = true
      return value
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(decided).toBe(false)
    release()
    await result
    await expect(decision).resolves.toMatchObject({ resumeOnSelectedAccount: true })
  })

  it('never lends the switch to a different thread, and keeps it for the right one', async () => {
    const stops = new CodexAccountRestartStops()
    const { result, release } = admitStop(stops)
    release()
    await result
    const other = await resume(stops, {
      resumeProviderSession: { key: 'session_id', id: 'thread-2', transcriptPath: '/x.jsonl' }
    })
    expect(other).toEqual({
      providerSession: { key: 'session_id', id: 'thread-2', transcriptPath: '/x.jsonl' },
      resumeOnSelectedAccount: false
    })
    await expect(resume(stops)).resolves.toMatchObject({ resumeOnSelectedAccount: true })
  })

  it('spends the intent once; a failed launch puts it back for the next resume', async () => {
    const stops = new CodexAccountRestartStops()
    const { result, release } = admitStop(stops)
    release()
    await result
    const first = await resume(stops)
    await expect(resume(stops)).resolves.toMatchObject({ resumeOnSelectedAccount: false })
    first.unspend?.()
    await expect(resume(stops)).resolves.toMatchObject({ resumeOnSelectedAccount: true })
  })

  it('leaves the intent unspent across an exact reattach', async () => {
    const stops = new CodexAccountRestartStops()
    const { result, release } = admitStop(stops)
    release()
    await result
    await expect(resume(stops, { preAdopted: true })).resolves.toMatchObject({
      resumeOnSelectedAccount: false
    })
    await expect(resume(stops)).resolves.toMatchObject({ resumeOnSelectedAccount: true })
  })

  it('resumes pinned without writer proof', async () => {
    const stops = new CodexAccountRestartStops()
    const { result, release } = admitStop(stops, 'unknown')
    release()
    await expect(result).resolves.toMatchObject({ outcome: 'unknown' })
    await expect(resume(stops)).resolves.toMatchObject({ resumeOnSelectedAccount: false })
  })

  it('fails explicitly when the route changed after the stop', async () => {
    const stops = new CodexAccountRestartStops()
    const { result, release } = admitStop(stops)
    release()
    await result
    await expect(resume(stops, { isDaemonHostSpawn: false })).rejects.toBeInstanceOf(
      CodexAccountRestartResumeUnavailableError
    )
    // The failed launch keeps the intent for the next resume on a capable route.
    await expect(resume(stops)).resolves.toMatchObject({ resumeOnSelectedAccount: true })
  })

  it('keeps refusing a shell for the stopped pane until the user dismisses the failure', async () => {
    const stops = new CodexAccountRestartStops()
    const { result, release } = admitStop(stops)
    release()
    await result
    const refusalId = await readRefusal(stops)
    // An automatic remount is refused again: no shell appears behind the user's back.
    expect(await readRefusal(stops)).toBe(refusalId)
    stops.releaseRefusedPane(codexAccountRestartPaneKey(pane), refusalId)
    await expect(
      resume(stops, { launchAgent: undefined, resumeProviderSession: undefined })
    ).resolves.toMatchObject({
      resumeOnSelectedAccount: false
    })
  })

  it('a late Dismiss of an earlier refusal leaves the newer refusal standing', async () => {
    const stops = new CodexAccountRestartStops()
    const first = admitStop(stops)
    first.release()
    await first.result
    const oldRefusal = await readRefusal(stops)
    stops.forgetPane(codexAccountRestartPaneKey(pane))
    const second = admitStop(stops)
    second.release()
    await second.result
    const newRefusal = await readRefusal(stops)

    expect(stops.releaseRefusedPane(codexAccountRestartPaneKey(pane), oldRefusal)).toBe(false)
    expect(await readRefusal(stops)).toBe(newRefusal)
    expect(stops.releaseRefusedPane(codexAccountRestartPaneKey(pane), newRefusal)).toBe(true)
  })

  it('closing the refused pane also ends the refusal', async () => {
    const stops = new CodexAccountRestartStops()
    const { result, release } = admitStop(stops)
    release()
    await result
    const withoutConversation = { launchAgent: undefined, resumeProviderSession: undefined }
    await expect(resume(stops, withoutConversation)).rejects.toBeInstanceOf(
      CodexAccountRestartResumeUnavailableError
    )
    stops.forgetPane(codexAccountRestartPaneKey(pane))
    await expect(resume(stops, withoutConversation)).resolves.toMatchObject({
      resumeOnSelectedAccount: false
    })
  })

  it('opens the shell normally when the stop was Dismissed, unproven or never made', async () => {
    const unproven = new CodexAccountRestartStops()
    const stop = admitStop(unproven, 'unknown')
    stop.release()
    await stop.result
    const withoutConversation = { launchAgent: undefined, resumeProviderSession: undefined }
    await expect(resume(unproven, withoutConversation)).resolves.toMatchObject({
      resumeOnSelectedAccount: false
    })
    await expect(
      resume(new CodexAccountRestartStops(), withoutConversation)
    ).resolves.toMatchObject({ resumeOnSelectedAccount: false })
  })

  it('after main loss resumes exactly the recorded transcript on the old account', async () => {
    // A fresh register stands for main after a restart: the in-memory intent is gone.
    const decision = await resume(new CodexAccountRestartStops(), {
      resumeProviderSession: {
        key: 'session_id',
        id: 'thread-1',
        transcriptPath: ORIGINAL_TRANSCRIPT
      }
    })
    expect(decision).toEqual({
      providerSession: { key: 'session_id', id: 'thread-1', transcriptPath: ORIGINAL_TRANSCRIPT },
      resumeOnSelectedAccount: false
    })
  })
})
